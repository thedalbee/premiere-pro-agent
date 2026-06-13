/**
 * prproj-inject.ts
 *
 * Injects N clip track items directly into an existing (empty) sequence
 * in a .prproj file (gzipped XML) — no UXP API round-trips.
 *
 * Why this approach:
 *   - The UXP sequence.cut API loop kills the runtime above ~200 clips.
 *   - FCP 7 XML import loses track mixer settings (EQ, volume, panner chain).
 *   - Direct injection: zero API calls, full fidelity, atomic file write.
 *
 * The target sequence must already exist in the project (created in Premiere
 * or via the sequence.create UXP action). The sequence must be empty — if it
 * already has clips the function throws rather than overwriting.
 *
 * Empirically confirmed structure (I45 project, 2026-06-13):
 *   clip 1 (V+A) = 24 objects:
 *     Video: VideoClipTrackItem + VideoComponentChain + VideoFilterComponent
 *            + 11×ArbVideoComponentParam + SubClip + VideoClip
 *     Audio: AudioClipTrackItem + AudioComponentChain + AudioFilterComponent
 *            + 2×AudioComponentParam + SubClip + AudioClip + SecondaryContent
 *   Shared (never cloned): VideoMediaSource, AudioMediaSource, MarkerOwner
 *
 * Insertion position: new objects go adjacent to existing clip block (L099).
 * Inserting at </PremiereData> causes Premiere to silently discard them.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

export const TICKS_PER_SECOND = 254016000000n;
export const TICKS_PER_FRAME_30 = 8467200000n;

export interface ClipRange {
  /** source start in seconds (already frame-grid-snapped) */
  start: number;
  /** source end in seconds (already frame-grid-snapped) */
  end: number;
}

export interface InjectOptions {
  /** path to the .prproj file (gzipped XML) */
  prprojPath: string;
  /** name of the existing (empty) sequence to inject into */
  targetSequenceName: string;
  /** absolute path to the source media file (must already be in project) */
  mediaPath: string;
  /** clips to place: source ranges in seconds, frame-grid-snapped */
  clips: ClipRange[];
  /** write a debug JSON beside the prproj (default false) */
  debug?: boolean;
}

export interface InjectResult {
  /** absolute path to the written .prproj file */
  outputPath: string;
  /** absolute path to the .bak backup */
  backupPath: string;
  /** absolute path to debug JSON (only if debug:true) */
  debugPath?: string;
  /** number of clips injected */
  clipsInjected: number;
  /** total new objects written */
  objectsCreated: number;
  /** self-validation results */
  validation: ValidationResult;
}

export interface ValidationResult {
  wellFormed: boolean;
  allRefsResolved: boolean;
  newIdDuplicates: boolean;
  videoTrackItemCount: number;
  audioTrackItemCount: number;
  expectedClipCount: number;
  passed: boolean;
  errors: string[];
}

// ── low-level helpers ──────────────────────────────────────────────────────

function newGuid(): string {
  return crypto.randomUUID();
}

/** Decompress a .prproj (gzip) to an XML string. */
function gunzipSync(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return zlib.gunzipSync(buf).toString("utf8");
}

/** Gzip + write XML to filePath atomically via a temp file. */
function gzipWriteSync(filePath: string, xml: string): void {
  const tmp = filePath + ".tmp." + process.pid;
  const buf = zlib.gzipSync(Buffer.from(xml, "utf8"), { level: 6 });
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, filePath);
}

/**
 * Extract a single top-level element block by tag + ObjectID.
 * Handles both element form (<Tag ...>...</Tag>) and self-closing (<Tag .../>).
 */
function extractElement(xml: string, tag: string, objectId: number): string | null {
  // Full element
  const pattern = new RegExp(`\t<${tag} ObjectID="${objectId}"[^>]*>.*?<\\/${tag}>`, "s");
  const m = pattern.exec(xml);
  if (m) return m[0];
  // Self-closing
  const pattern2 = new RegExp(`\t<${tag} ObjectID="${objectId}"[^/]*/>`);
  const m2 = pattern2.exec(xml);
  if (m2) return m2[0];
  return null;
}

/**
 * Extract a top-level element by ObjectUID (GUID).
 */
function extractElementByUid(xml: string, tag: string, uid: string): string | null {
  const escaped = uid.replace(/-/g, "\\-");
  const pattern = new RegExp(`\t<${tag} ObjectUID="${escaped}"[^>]*>.*?<\\/${tag}>`, "s");
  const m = pattern.exec(xml);
  if (m) return m[0];
  const pattern2 = new RegExp(`\t<${tag} ObjectUID="${escaped}"[^/]*/>`);
  const m2 = pattern2.exec(xml);
  if (m2) return m2[0];
  return null;
}

/**
 * Get the tag name for an ObjectID (scans entire XML).
 */
function tagForId(xml: string, objectId: number): string | null {
  // Use a fast search — find the ObjectID attribute, then walk back to the tag name
  const marker = `ObjectID="${objectId}"`;
  const idx = xml.indexOf(marker);
  if (idx === -1) return null;
  // Walk back to the '<'
  let start = idx - 1;
  while (start > 0 && xml[start] !== "<") start--;
  const tagPart = xml.slice(start + 1, idx).trim();
  // tagPart may include preceding whitespace attributes; take first token
  return tagPart.split(/\s+/)[0] ?? null;
}

/** Parse all numeric ObjectIDs in the XML. */
function collectAllObjectIds(xml: string): Set<number> {
  const ids = new Set<number>();
  const re = /ObjectID="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    ids.add(parseInt(m[1], 10));
  }
  return ids;
}

function maxObjectId(xml: string): number {
  let max = 0;
  const re = /ObjectID="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

// ── clip injection ─────────────────────────────────────────────────────────

/**
 * Find ALL VideoMediaSource and AudioMediaSource ObjectIDs for a media path.
 *
 * Strategy: find the <Media> element(s) whose <FilePath> or <Title> matches
 * the given path or basename, collect their ObjectUIDs, then find every
 * VideoMediaSource / AudioMediaSource that references those Media UIDs.
 *
 * A single media file can have several source objects in one project (e.g.
 * re-imports, conform variants) — clips may reference any of them, so callers
 * must treat the whole set as valid (the I45 project has both 253 and 272
 * for the same .mp4).
 */
function findMediaSourceIds(
  xml: string,
  mediaPath: string,
): { videoSourceIds: number[]; audioSourceIds: number[] } {
  const baseName = path.basename(mediaPath);
  const absPath = mediaPath.includes("/") ? mediaPath : null;

  // Collect Media UIDs whose path matches
  const matchedMediaUids = new Set<string>();
  const mediaRe = /Media ObjectUID="([0-9a-f-]{36})"[^>]*>[\s\S]*?<\/Media>/g;
  let mm: RegExpExecArray | null;
  while ((mm = mediaRe.exec(xml)) !== null) {
    const block = mm[0];
    const titleMatch = /<Title>([^<]+)<\/Title>/.exec(block);
    const pathMatch = /<(?:FilePath|ActualMediaFilePath|RelativePath)>([^<]+)<\/(?:FilePath|ActualMediaFilePath|RelativePath)>/.exec(block);
    const blockTitle = titleMatch?.[1] ?? "";
    const blockPath = pathMatch?.[1] ?? "";
    if (
      blockTitle === baseName ||
      path.basename(blockTitle) === baseName ||
      blockPath.endsWith(baseName) ||
      (absPath && blockPath === absPath)
    ) {
      matchedMediaUids.add(mm[1]);
    }
  }

  if (matchedMediaUids.size === 0) {
    return { videoSourceIds: [], audioSourceIds: [] };
  }

  // Collect every VideoMediaSource / AudioMediaSource that references any of
  // those Media UIDs.
  const videoSourceIds: number[] = [];
  const audioSourceIds: number[] = [];

  for (const m of xml.matchAll(
    /<VideoMediaSource ObjectID="(\d+)"[^>]*>[\s\S]*?<\/VideoMediaSource>/g,
  )) {
    const uidMatch = /Media ObjectURef="([0-9a-f-]{36})"/.exec(m[0]);
    if (uidMatch && matchedMediaUids.has(uidMatch[1])) {
      videoSourceIds.push(parseInt(m[1], 10));
    }
  }
  for (const m of xml.matchAll(
    /<AudioMediaSource ObjectID="(\d+)"[^>]*>[\s\S]*?<\/AudioMediaSource>/g,
  )) {
    const uidMatch = /Media ObjectURef="([0-9a-f-]{36})"/.exec(m[0]);
    if (uidMatch && matchedMediaUids.has(uidMatch[1])) {
      audioSourceIds.push(parseInt(m[1], 10));
    }
  }

  return { videoSourceIds, audioSourceIds };
}

// ── template clip block extraction ────────────────────────────────────────

interface TemplateClipIds {
  videoTrackItemId: number;
  videoComponentChainId: number;
  // null when the chain is Premiere's native default stub (DefaultMotion /
  // DefaultOpacity flags, empty ComponentChain) — the common case for clips
  // placed by the editor or the UXP API. The full filter chain only appears
  // on FCP-XML-imported clips.
  videoFilterComponentId: number | null;
  videoFilterParamIds: number[];
  videoSubClipId: number;
  videoClipId: number;
  audioTrackItemId: number;
  audioComponentChainId: number;
  audioFilterComponentId: number | null;
  audioFilterParamIds: number[];
  audioSubClipId: number;
  audioClipId: number;
  // stereo clips carry 2 secondary content items; mono 1; may be absent
  secondaryContentIds: number[];
  videoMediaSourceId: number;
  audioMediaSourceId: number;
  markerOwnerId: number;
}

/**
 * Extract template clip IDs from an existing VideoClipTrackItem + AudioClipTrackItem pair.
 * Reads from the last (highest-index) pair in the given track item lists.
 * Returns null if either track is empty — callers should then fall back to findDonorClipIds().
 */
function extractTemplateClipIds(
  xml: string,
  vTrackUid: string,
  aTrackUid: string,
): TemplateClipIds | null {
  // Get the last VideoClipTrackItem ObjectRef in the V track
  const vTrackBlock = extractElementByUid(xml, "VideoClipTrack", vTrackUid);
  if (!vTrackBlock) return null;
  const vItemRefs = [...vTrackBlock.matchAll(/TrackItem Index="\d+" ObjectRef="(\d+)"/g)].map((m) =>
    parseInt(m[1], 10),
  );
  if (vItemRefs.length === 0) return null;
  const lastVItemId = vItemRefs[vItemRefs.length - 1];

  const aTrackBlock = extractElementByUid(xml, "AudioClipTrack", aTrackUid);
  if (!aTrackBlock) return null;
  const aItemRefs = [...aTrackBlock.matchAll(/TrackItem Index="\d+" ObjectRef="(\d+)"/g)].map(
    (m) => parseInt(m[1], 10),
  );
  if (aItemRefs.length === 0) return null;
  const lastAItemId = aItemRefs[aItemRefs.length - 1];

  return resolveClipChain(xml, lastVItemId, lastAItemId);
}

/**
 * Donor search: when the target sequence has no clips (an empty sequence
 * created in Premiere), find any clip of the target media elsewhere in the
 * project and use its object chain as the donor.
 *
 * Walks every VideoClipTrackItem in the file, follows SubClip→VideoClip→Source
 * and picks the first one whose Source matches videoSourceId. Audio likewise.
 * Prefers clips without transitions (their transition refs would dangle).
 */
function findDonorClipIds(
  xml: string,
  videoSourceIds: ReadonlySet<number>,
  audioSourceIds: ReadonlySet<number>,
): { vItemId: number; aItemId: number } | null {
  let vItemId: number | null = null;
  let aItemId: number | null = null;

  // Pre-index: SubClip id → Clip ObjectRef, and VideoClip/AudioClip id → Source ObjectRef.
  // One pass each instead of per-candidate full-file regex scans (file is ~15MB).
  const subClipToClip = new Map<number, number>();
  for (const m of xml.matchAll(
    /<SubClip ObjectID="(\d+)"[^>]*>\s*<Clip ObjectRef="(\d+)"\/>/g,
  )) {
    subClipToClip.set(parseInt(m[1], 10), parseInt(m[2], 10));
  }

  const clipToSource = new Map<number, number>();
  for (const m of xml.matchAll(
    /<(?:VideoClip|AudioClip) ObjectID="(\d+)"[^>]*>[\s\S]{0,400}?<Source ObjectRef="(\d+)"\/>/g,
  )) {
    clipToSource.set(parseInt(m[1], 10), parseInt(m[2], 10));
  }

  // Video donor: first VideoClipTrackItem whose chain resolves to a matching
  // source. Prefer items without transitions — transition objects are not part
  // of the cloned chain and head/tail refs would dangle.
  let vFallback: number | null = null;
  for (const m of xml.matchAll(
    /<VideoClipTrackItem ObjectID="(\d+)"[^>]*>([\s\S]*?)<\/VideoClipTrackItem>/g,
  )) {
    const body = m[2];
    const subRef = /<SubClip ObjectRef="(\d+)"\/>/.exec(body);
    if (!subRef) continue;
    const clipId = subClipToClip.get(parseInt(subRef[1], 10));
    if (clipId === undefined) continue;
    const src = clipToSource.get(clipId);
    if (src === undefined || !videoSourceIds.has(src)) continue;
    if (body.includes("Transition")) {
      vFallback ??= parseInt(m[1], 10);
      continue;
    }
    vItemId = parseInt(m[1], 10);
    break;
  }
  vItemId ??= vFallback;

  // Audio donor: same, preferring transition-free items
  let aFallback: number | null = null;
  for (const m of xml.matchAll(
    /<AudioClipTrackItem ObjectID="(\d+)"[^>]*>([\s\S]*?)<\/AudioClipTrackItem>/g,
  )) {
    const body = m[2];
    const subRef = /<SubClip ObjectRef="(\d+)"\/>/.exec(body);
    if (!subRef) continue;
    const clipId = subClipToClip.get(parseInt(subRef[1], 10));
    if (clipId === undefined) continue;
    const src = clipToSource.get(clipId);
    if (src === undefined || !audioSourceIds.has(src)) continue;
    if (body.includes("Transition")) {
      aFallback ??= parseInt(m[1], 10);
      continue;
    }
    aItemId = parseInt(m[1], 10);
    break;
  }
  aItemId ??= aFallback;

  if (vItemId === null || aItemId === null) return null;
  return { vItemId, aItemId };
}

/**
 * Resolve the full clip chain starting from a
 * VideoClipTrackItem + AudioClipTrackItem pair.
 */
function resolveClipChain(
  xml: string,
  lastVItemId: number,
  lastAItemId: number,
): TemplateClipIds | null {
  // Parse VideoClipTrackItem
  const vItemBlock = extractElement(xml, "VideoClipTrackItem", lastVItemId);
  if (!vItemBlock) return null;
  const vChainRef = /Components ObjectRef="(\d+)"/.exec(vItemBlock);
  const vSubClipRef = /SubClip ObjectRef="(\d+)"/.exec(vItemBlock);
  if (!vChainRef || !vSubClipRef) return null;
  const videoComponentChainId = parseInt(vChainRef[1], 10);
  const videoSubClipId = parseInt(vSubClipRef[1], 10);

  // Parse VideoComponentChain → VideoFilterComponent → params.
  // Native clips use a default stub chain (DefaultMotion, empty ComponentChain)
  // with no Component refs — that shape is valid and clones as-is.
  const vChainBlock = extractElement(xml, "VideoComponentChain", videoComponentChainId);
  if (!vChainBlock) return null;
  const vFilterRef = /Component Index="0" ObjectRef="(\d+)"/.exec(vChainBlock);
  let videoFilterComponentId: number | null = null;
  let vParamRefs: number[] = [];
  if (vFilterRef) {
    videoFilterComponentId = parseInt(vFilterRef[1], 10);
    const vFilterBlock = extractElement(xml, "VideoFilterComponent", videoFilterComponentId);
    if (!vFilterBlock) return null;
    vParamRefs = [...vFilterBlock.matchAll(/Param Index="\d+" ObjectRef="(\d+)"/g)].map((m) =>
      parseInt(m[1], 10),
    );
  }

  // Parse SubClip → VideoClip
  const vSubClipBlock = extractElement(xml, "SubClip", videoSubClipId);
  if (!vSubClipBlock) return null;
  const vClipRef = /Clip ObjectRef="(\d+)"/.exec(vSubClipBlock);
  if (!vClipRef) return null;
  const videoClipId = parseInt(vClipRef[1], 10);

  // VideoClip → Source (shared VideoMediaSource)
  const vClipBlock = extractElement(xml, "VideoClip", videoClipId);
  if (!vClipBlock) return null;
  const vSrcRef = /Source ObjectRef="(\d+)"/.exec(vClipBlock);
  const vMarkRef = /Markers ObjectRef="(\d+)"/.exec(vClipBlock);
  if (!vSrcRef) return null;
  const videoMediaSourceId = parseInt(vSrcRef[1], 10);
  const markerOwnerId = vMarkRef ? parseInt(vMarkRef[1], 10) : 0;

  // Parse AudioClipTrackItem
  const aItemBlock = extractElement(xml, "AudioClipTrackItem", lastAItemId);
  if (!aItemBlock) return null;
  const aChainRef = /Components ObjectRef="(\d+)"/.exec(aItemBlock);
  const aSubClipRef = /SubClip ObjectRef="(\d+)"/.exec(aItemBlock);
  if (!aChainRef || !aSubClipRef) return null;
  const audioComponentChainId = parseInt(aChainRef[1], 10);
  const audioSubClipId = parseInt(aSubClipRef[1], 10);

  // AudioComponentChain → AudioFilterComponent → params (stub chains allowed)
  const aChainBlock = extractElement(xml, "AudioComponentChain", audioComponentChainId);
  if (!aChainBlock) return null;
  const aFilterRef = /Component Index="0" ObjectRef="(\d+)"/.exec(aChainBlock);
  let audioFilterComponentId: number | null = null;
  let aParamRefs: number[] = [];
  if (aFilterRef) {
    audioFilterComponentId = parseInt(aFilterRef[1], 10);
    const aFilterBlock = extractElement(xml, "AudioFilterComponent", audioFilterComponentId);
    if (!aFilterBlock) return null;
    aParamRefs = [...aFilterBlock.matchAll(/Param Index="\d+" ObjectRef="(\d+)"/g)].map((m) =>
      parseInt(m[1], 10),
    );
  }

  // AudioSubClip → AudioClip
  const aSubClipBlock = extractElement(xml, "SubClip", audioSubClipId);
  if (!aSubClipBlock) return null;
  const aClipRef = /Clip ObjectRef="(\d+)"/.exec(aSubClipBlock);
  if (!aClipRef) return null;
  const audioClipId = parseInt(aClipRef[1], 10);

  // AudioClip → SecondaryContents → SecondaryContentItem → SecondaryContent
  const aClipBlock = extractElement(xml, "AudioClip", audioClipId);
  if (!aClipBlock) return null;
  const aSrcRef = /Source ObjectRef="(\d+)"/.exec(aClipBlock);
  if (!aSrcRef) return null;
  const audioMediaSourceId = parseInt(aSrcRef[1], 10);
  // 0..N secondary content items (stereo native clips carry 2, mono 1)
  const secondaryContentIds = [
    ...aClipBlock.matchAll(/SecondaryContentItem Index="\d+" ObjectRef="(\d+)"/g),
  ].map((m) => parseInt(m[1], 10));

  return {
    videoTrackItemId: lastVItemId,
    videoComponentChainId,
    videoFilterComponentId,
    videoFilterParamIds: vParamRefs,
    videoSubClipId,
    videoClipId,
    audioTrackItemId: lastAItemId,
    audioComponentChainId,
    audioFilterComponentId,
    audioFilterParamIds: aParamRefs,
    audioSubClipId,
    audioClipId,
    secondaryContentIds,
    videoMediaSourceId,
    audioMediaSourceId,
    markerOwnerId,
  };
}

// ── remap helpers ─────────────────────────────────────────────────────────

/**
 * Apply ID remapping to a cloned XML block.
 * old→new for both ObjectID and ObjectRef attributes.
 */
function remapBlock(
  block: string,
  idMap: Map<number, number>,
): string {
  let result = block;

  // Remap ObjectID / ObjectRef (numeric) — longest ID first to avoid partial matches
  const sortedIds = [...idMap.entries()].sort((a, b) => b[0] - a[0]);
  for (const [oldId, newId] of sortedIds) {
    result = result.replaceAll(`ObjectID="${oldId}"`, `ObjectID="${newId}"`);
    result = result.replaceAll(`ObjectRef="${oldId}"`, `ObjectRef="${newId}"`);
  }

  return result;
}

// ── sequence lookup helpers ────────────────────────────────────────────────

/**
 * Find a sequence block by name in the XML.
 * Returns { uid, block } or null if not found.
 */
function findSequenceByName(
  xml: string,
  name: string,
): { uid: string; block: string } | null {
  const seqUidRe = /Sequence ObjectUID="([0-9a-f-]{36})"/g;
  let seqM: RegExpExecArray | null;
  while ((seqM = seqUidRe.exec(xml)) !== null) {
    const uid = seqM[1];
    const seqStart = xml.lastIndexOf("<", seqM.index);
    const seqEndTag = xml.indexOf("</Sequence>", seqStart);
    if (seqEndTag === -1) continue;
    const block = xml.slice(seqStart, seqEndTag + "</Sequence>".length);
    if (block.includes(`<Name>${name}</Name>`)) {
      return { uid, block };
    }
  }
  return null;
}

/**
 * Check if a sequence name exists in the XML.
 * Exported for use by cut.ts to determine whether to create the sequence via UXP.
 */
export function sequenceExistsInXml(xml: string, name: string): boolean {
  return findSequenceByName(xml, name) !== null;
}

/**
 * Decompress a .prproj and check if the named sequence exists.
 */
export function sequenceExistsInPrproj(prprojPath: string, name: string): boolean {
  const xml = gunzipSync(prprojPath);
  return sequenceExistsInXml(xml, name);
}

// ── main injection entry point ─────────────────────────────────────────────

export async function injectClips(options: InjectOptions): Promise<InjectResult> {
  const {
    prprojPath,
    targetSequenceName,
    mediaPath,
    clips,
    debug = false,
  } = options;

  if (!fs.existsSync(prprojPath)) throw new Error(`prproj not found: ${prprojPath}`);
  if (clips.length === 0) throw new Error("clips array is empty");

  // ── 1. Decompress ──────────────────────────────────────────────────────────
  let xml = gunzipSync(prprojPath);

  // ── 2. Find target sequence ───────────────────────────────────────────────
  const seqFound = findSequenceByName(xml, targetSequenceName);
  if (!seqFound) {
    throw new Error(
      `Sequence "${targetSequenceName}" not found in project. ` +
        `Create it in Premiere first, or open the project and let ppro cut create it.`,
    );
  }
  const { uid: targetSeqUid, block: targetSeqBlock } = seqFound;

  // ── 3. Find target sequence's V1/A1 track UIDs ───────────────────────────
  const vTrackGroupRef = /Second ObjectRef="(\d+)"/.exec(targetSeqBlock);
  if (!vTrackGroupRef) throw new Error("Target sequence: VideoTrackGroup ObjectRef not found");
  const vTrackGroupId = parseInt(vTrackGroupRef[1], 10);

  const vTrackGroupBlock = extractElement(xml, "VideoTrackGroup", vTrackGroupId);
  if (!vTrackGroupBlock) throw new Error("VideoTrackGroup not found for target sequence");
  const v1TrackUidMatch = /Track Index="0" ObjectURef="([0-9a-f-]{36})"/.exec(vTrackGroupBlock);
  if (!v1TrackUidMatch) throw new Error("V1 track ObjectURef not found in VideoTrackGroup");
  const v1TrackUid = v1TrackUidMatch[1];

  // Audio track group — second TrackGroup entry
  const trackGroupEntries = [...targetSeqBlock.matchAll(/Second ObjectRef="(\d+)"/g)];
  if (trackGroupEntries.length < 2) throw new Error("Target sequence: AudioTrackGroup ref not found");
  const aTrackGroupId = parseInt(trackGroupEntries[1][1], 10);
  const aTrackGroupBlock = extractElement(xml, "AudioTrackGroup", aTrackGroupId);
  if (!aTrackGroupBlock) throw new Error("AudioTrackGroup not found for target sequence");
  const a1TrackUidMatch = /Track Index="0" ObjectURef="([0-9a-f-]{36})"/.exec(aTrackGroupBlock);
  if (!a1TrackUidMatch) throw new Error("A1 track ObjectURef not found in AudioTrackGroup");
  const a1TrackUid = a1TrackUidMatch[1];

  // ── 4. Reject non-empty target sequence ──────────────────────────────────
  const v1TrackBlock = extractElementByUid(xml, "VideoClipTrack", v1TrackUid) ?? "";
  const existingV1Items = (v1TrackBlock.match(/TrackItem Index=/g) ?? []).length;
  if (existingV1Items > 0) {
    throw new Error(
      `Sequence "${targetSequenceName}" already has ${existingV1Items} clip(s) on V1. ` +
        `Pass an empty sequence. Overwriting existing clips is not supported.`,
    );
  }

  // ── 5. Verify media is already imported ──────────────────────────────────
  const { videoSourceIds, audioSourceIds } = findMediaSourceIds(xml, mediaPath);
  if (videoSourceIds.length === 0 || audioSourceIds.length === 0) {
    throw new Error(
      `Media "${path.basename(mediaPath)}" not found in project. ` +
        `Import it into Premiere first, then run this command.`,
    );
  }
  const videoSourceIdSet = new Set(videoSourceIds);
  const audioSourceIdSet = new Set(audioSourceIds);

  // ── 6. Find donor clip chain ──────────────────────────────────────────────
  // Primary: last clip pair on the target's own V1/A1 tracks (not possible
  // since we just verified the sequence is empty — this path is a safety net
  // in case the check above is ever relaxed).
  // Fallback: any clip of the target media elsewhere in the project.
  let donorClip = extractTemplateClipIds(xml, v1TrackUid, a1TrackUid);
  if (!donorClip) {
    const donor = findDonorClipIds(xml, videoSourceIdSet, audioSourceIdSet);
    if (donor) {
      donorClip = resolveClipChain(xml, donor.vItemId, donor.aItemId);
    }
  }
  if (!donorClip) {
    throw new Error(
      `No donor clip of media "${path.basename(mediaPath)}" exists in the project. ` +
        `Place at least one clip of this media in any sequence, then retry. ` +
        `Alternatively, use --live to place clips via the UXP API.`,
    );
  }

  // Pick the concrete source pair for the new clips
  const videoSourceId = videoSourceIdSet.has(donorClip.videoMediaSourceId)
    ? donorClip.videoMediaSourceId
    : videoSourceIds[0];
  const audioSourceId = audioSourceIdSet.has(donorClip.audioMediaSourceId)
    ? donorClip.audioMediaSourceId
    : audioSourceIds[0];

  // ── 7. Assign new IDs ─────────────────────────────────────────────────────
  const firstNewId = maxObjectId(xml) + 1;
  let nextId = firstNewId;

  // ── 8. Build N clip objects ───────────────────────────────────────────────
  const TICKS = TICKS_PER_SECOND;

  const vTrackItemIds: number[] = [];
  const aTrackItemIds: number[] = [];
  const clipBlocks: string[] = [];

  let timelineCursor = 0n;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const srcStartTicks = BigInt(Math.round(clip.start * Number(TICKS)));
    const srcEndTicks = BigInt(Math.round(clip.end * Number(TICKS)));
    const durationTicks = srcEndTicks - srcStartTicks;
    const timelineStart = timelineCursor;
    const timelineEnd = timelineCursor + durationTicks;
    timelineCursor = timelineEnd;

    // Allocate IDs for this clip's objects.
    const newVItemId = nextId++;
    const newVChainId = nextId++;
    const newVFilterId = donorClip.videoFilterComponentId !== null ? nextId++ : null;
    const newVParamIds = donorClip.videoFilterParamIds.map(() => nextId++);
    const newVSubClipId = nextId++;
    const newVClipId = nextId++;

    const newAItemId = nextId++;
    const newAChainId = nextId++;
    const newAFilterId = donorClip.audioFilterComponentId !== null ? nextId++ : null;
    const newAParamIds = donorClip.audioFilterParamIds.map(() => nextId++);
    const newASubClipId = nextId++;
    const newAClipId = nextId++;
    const newSecContentIds = donorClip.secondaryContentIds.map(() => nextId++);

    vTrackItemIds.push(newVItemId);
    aTrackItemIds.push(newAItemId);

    // Build the ID remap for this clip
    const clipIdMap = new Map<number, number>([
      [donorClip.videoTrackItemId, newVItemId],
      [donorClip.videoComponentChainId, newVChainId],
      ...(donorClip.videoFilterComponentId !== null
        ? [[donorClip.videoFilterComponentId, newVFilterId!] as [number, number]]
        : []),
      ...donorClip.videoFilterParamIds.map((id, j): [number, number] => [id, newVParamIds[j]]),
      [donorClip.videoSubClipId, newVSubClipId],
      [donorClip.videoClipId, newVClipId],
      [donorClip.audioTrackItemId, newAItemId],
      [donorClip.audioComponentChainId, newAChainId],
      ...(donorClip.audioFilterComponentId !== null
        ? [[donorClip.audioFilterComponentId, newAFilterId!] as [number, number]]
        : []),
      ...donorClip.audioFilterParamIds.map((id, j): [number, number] => [id, newAParamIds[j]]),
      [donorClip.audioSubClipId, newASubClipId],
      [donorClip.audioClipId, newAClipId],
      ...donorClip.secondaryContentIds.map((id, j): [number, number] => [id, newSecContentIds[j]]),
    ]);

    const buildClipBlock = (tag: string, id: number): string => {
      const block = extractElement(xml, tag, id);
      if (!block) throw new Error(`Donor block missing: ${tag} ObjectID=${id}`);
      let remapped = remapBlock(block, clipIdMap);
      // Fix media source refs to the actual media (in case donor used different source)
      remapped = remapped.replaceAll(
        `ObjectRef="${donorClip.videoMediaSourceId}"`,
        `ObjectRef="${videoSourceId}"`,
      );
      remapped = remapped.replaceAll(
        `ObjectRef="${donorClip.audioMediaSourceId}"`,
        `ObjectRef="${audioSourceId}"`,
      );
      return remapped;
    };

    // Donor items may carry transition refs — strip them (transition objects are
    // not cloned and their refs would dangle in the new clips).
    const stripTransitions = (block: string): string =>
      block
        .replace(/\s*<HeadTransition ObjectRef="\d+"\/>/g, "")
        .replace(/\s*<TailTransition ObjectRef="\d+"\/>/g, "");

    // VideoClipTrackItem — update timeline Start/End
    let vItem = buildClipBlock("VideoClipTrackItem", donorClip.videoTrackItemId);
    vItem = stripTransitions(vItem);
    vItem = replaceTimelinePosition(vItem, timelineStart, timelineEnd);

    // VideoClip — update source InPoint/OutPoint + new ClipID
    let vClip = buildClipBlock("VideoClip", donorClip.videoClipId);
    vClip = vClip.replace(/<InPoint>\d+<\/InPoint>/, `<InPoint>${srcStartTicks}</InPoint>`);
    vClip = vClip.replace(/<OutPoint>\d+<\/OutPoint>/, `<OutPoint>${srcEndTicks}</OutPoint>`);
    vClip = vClip.replace(/<ClipID>[^<]+<\/ClipID>/, `<ClipID>${newGuid()}</ClipID>`);

    // AudioClipTrackItem — update timeline Start/End + new ID GUID
    let aItem = buildClipBlock("AudioClipTrackItem", donorClip.audioTrackItemId);
    aItem = stripTransitions(aItem);
    aItem = replaceTimelinePosition(aItem, timelineStart, timelineEnd);
    aItem = aItem.replace(/<ID>[0-9a-f-]{36}<\/ID>/, `<ID>${newGuid()}</ID>`);

    // AudioClip — update source InPoint/OutPoint + new ClipID
    let aClip = buildClipBlock("AudioClip", donorClip.audioClipId);
    aClip = aClip.replace(/<InPoint>\d+<\/InPoint>/, `<InPoint>${srcStartTicks}</InPoint>`);
    aClip = aClip.replace(/<OutPoint>\d+<\/OutPoint>/, `<OutPoint>${srcEndTicks}</OutPoint>`);
    aClip = aClip.replace(/<ClipID>[^<]+<\/ClipID>/, `<ClipID>${newGuid()}</ClipID>`);

    const vChain = buildClipBlock("VideoComponentChain", donorClip.videoComponentChainId);
    const vSubClip = buildClipBlock("SubClip", donorClip.videoSubClipId);
    const aChain = buildClipBlock("AudioComponentChain", donorClip.audioComponentChainId);
    const aSubClip = buildClipBlock("SubClip", donorClip.audioSubClipId);

    // Filter components only exist on full (FCP-XML shape) chains
    const vFilterBlocks =
      donorClip.videoFilterComponentId !== null
        ? [buildClipBlock("VideoFilterComponent", donorClip.videoFilterComponentId)]
        : [];
    const aFilterBlocks =
      donorClip.audioFilterComponentId !== null
        ? [buildClipBlock("AudioFilterComponent", donorClip.audioFilterComponentId)]
        : [];

    const vFilterParams = donorClip.videoFilterParamIds.map((id) => {
      const tag = tagForId(xml, id)!;
      return buildClipBlock(tag, id);
    });
    const aFilterParams = donorClip.audioFilterParamIds.map((id) => {
      const tag = tagForId(xml, id)!;
      return buildClipBlock(tag, id);
    });
    const secContentBlocks = donorClip.secondaryContentIds.map((id) =>
      buildClipBlock("SecondaryContent", id),
    );

    clipBlocks.push(
      vItem,
      vChain,
      ...vFilterBlocks,
      ...vFilterParams,
      vSubClip,
      vClip,
      aItem,
      aChain,
      ...aFilterBlocks,
      ...aFilterParams,
      aSubClip,
      aClip,
      ...secContentBlocks,
    );
  }

  // ── 9. Update TrackItems lists in target V1/A1 tracks ────────────────────
  const vTrackItemsXml = vTrackItemIds
    .map((id, i) => `\t\t\t\t\t<TrackItem Index="${i}" ObjectRef="${id}"/>`)
    .join("\n");
  const aTrackItemsXml = aTrackItemIds
    .map((id, i) => `\t\t\t\t\t<TrackItem Index="${i}" ObjectRef="${id}"/>`)
    .join("\n");

  const setTrackItems = (block: string, itemsXml: string): string => {
    const filled = `<TrackItems Version="1">\n${itemsXml}\n\t\t\t\t</TrackItems>`;
    if (/<TrackItems Version="1">[\s\S]*?<\/TrackItems>/.test(block)) {
      return block.replace(/<TrackItems Version="1">[\s\S]*?<\/TrackItems>/, filled);
    }
    return block.replace(
      /<ClipItems Version="3">/,
      `<ClipItems Version="3">\n\t\t\t\t${filled}`,
    );
  };

  // Patch the target V1/A1 tracks in place
  const v1Block = extractElementByUid(xml, "VideoClipTrack", v1TrackUid);
  if (!v1Block) throw new Error("VideoClipTrack block not found for target V1");
  const updatedV1Block = setTrackItems(v1Block, vTrackItemsXml);
  xml = xml.replace(v1Block, updatedV1Block);

  const a1Block = extractElementByUid(xml, "AudioClipTrack", a1TrackUid);
  if (!a1Block) throw new Error("AudioClipTrack block not found for target A1");
  const updatedA1Block = setTrackItems(a1Block, aTrackItemsXml);
  xml = xml.replace(a1Block, updatedA1Block);

  // ── 10. Determine insertion anchor (adjacent to existing clip block) ───────
  // Find the donor's AudioClipTrackItem to use as anchor (L099 rule: insert
  // adjacent to existing clips, not at </PremiereData>).
  const anchorBlock = extractElement(xml, "AudioClipTrackItem", donorClip.audioTrackItemId);
  if (!anchorBlock) throw new Error("Could not find donor AudioClipTrackItem for insertion anchor");

  // Insert all new clip objects after the anchor
  xml = xml.replace(anchorBlock, anchorBlock + "\n" + clipBlocks.join("\n"));

  // ── 11. Self-validation ───────────────────────────────────────────────────
  const validation = selfValidate(xml, v1TrackUid, a1TrackUid, clips.length, nextId - 1);

  // ── 12. Write output ──────────────────────────────────────────────────────
  const backupPath = prprojPath + ".bak";
  fs.copyFileSync(prprojPath, backupPath);
  gzipWriteSync(prprojPath, xml);

  let debugPath: string | undefined;
  if (debug) {
    debugPath = prprojPath + ".inject-debug.json";
    const debugData = {
      targetSequenceName,
      targetSeqUid,
      v1TrackUid,
      a1TrackUid,
      clipCount: clips.length,
      objectsCreated: nextId - firstNewId,
      validation,
    };
    fs.writeFileSync(debugPath, JSON.stringify(debugData, null, 2));
  }

  return {
    outputPath: prprojPath,
    backupPath,
    debugPath,
    clipsInjected: clips.length,
    objectsCreated: nextId - firstNewId,
    validation,
  };
}

// ── helpers for clip injection ─────────────────────────────────────────────

function replaceTimelinePosition(block: string, start: bigint, end: bigint): string {
  // Replace <Start> and <End> inside <TrackItem>
  let result = block;
  result = result.replace(/<End>\d+<\/End>/, `<End>${end}</End>`);
  // <Start> may be absent for first clip (start=0 is default)
  if (start === 0n) {
    result = result.replace(/<Start>\d+<\/Start>/, "");
  } else if (/<Start>\d+<\/Start>/.test(result)) {
    result = result.replace(/<Start>\d+<\/Start>/, `<Start>${start}</Start>`);
  } else {
    result = result.replace(/<End>/, `<Start>${start}</Start>\n\t\t\t\t<End>`);
  }
  return result;
}

// ── self-validation ────────────────────────────────────────────────────────

export function selfValidate(
  xml: string,
  v1TrackUid: string,
  a1TrackUid: string,
  expectedClipCount: number,
  maxExpectedId: number,
): ValidationResult {
  const errors: string[] = [];

  // (a) Well-formed XML check (fast heuristic — no DOM parser)
  const wellFormed =
    xml.includes("<PremiereData") && xml.includes("</PremiereData>") && !xml.includes("</PremiereData></PremiereData>");

  // (b) All ObjectRefs resolve
  const allIds = new Set<number>();
  const idRe = /ObjectID="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(xml)) !== null) allIds.add(parseInt(m[1], 10));

  const unresolved: number[] = [];
  const refRe = /ObjectRef="(\d+)"/g;
  while ((m = refRe.exec(xml)) !== null) {
    const id = parseInt(m[1], 10);
    if (!allIds.has(id)) unresolved.push(id);
  }
  const allRefsResolved = unresolved.length === 0;
  if (!allRefsResolved) {
    errors.push(`${unresolved.length} unresolved ObjectRefs: ${unresolved.slice(0, 10).join(", ")}`);
  }

  // (c) No new duplicate IDs (IDs above the original max)
  const origMax = maxExpectedId - (expectedClipCount * 24 + 50);
  const newIdCounts = new Map<number, number>();
  const idRe2 = /ObjectID="(\d+)"/g;
  while ((m = idRe2.exec(xml)) !== null) {
    const id = parseInt(m[1], 10);
    if (id > origMax) {
      newIdCounts.set(id, (newIdCounts.get(id) ?? 0) + 1);
    }
  }
  const dupIds = [...newIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  const newIdDuplicates = dupIds.length > 0;
  if (newIdDuplicates) {
    errors.push(`Duplicate new ObjectIDs: ${dupIds.slice(0, 10).join(", ")}`);
  }

  // (d) V1 / A1 track item counts
  const v1Block = extractElementByUid(xml, "VideoClipTrack", v1TrackUid) ?? "";
  const videoTrackItemCount = (v1Block.match(/TrackItem Index=/g) ?? []).length;

  const a1Block = extractElementByUid(xml, "AudioClipTrack", a1TrackUid) ?? "";
  const audioTrackItemCount = (a1Block.match(/TrackItem Index=/g) ?? []).length;

  if (videoTrackItemCount !== expectedClipCount) {
    errors.push(`V1 has ${videoTrackItemCount} items, expected ${expectedClipCount}`);
  }
  if (audioTrackItemCount !== expectedClipCount) {
    errors.push(`A1 has ${audioTrackItemCount} items, expected ${expectedClipCount}`);
  }

  return {
    wellFormed,
    allRefsResolved,
    newIdDuplicates,
    videoTrackItemCount,
    audioTrackItemCount,
    expectedClipCount,
    passed: wellFormed && allRefsResolved && !newIdDuplicates && errors.length === 0,
    errors,
  };
}
