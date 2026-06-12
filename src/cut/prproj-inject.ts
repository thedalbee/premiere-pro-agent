/**
 * prproj-inject.ts
 *
 * Injects a new sequence (cloned from a CUT_TEMPLATE) with N clip track items
 * directly into a .prproj file (gzipped XML) — no UXP API round-trips.
 *
 * Why this approach:
 *   - The UXP sequence.cut API loop kills the runtime above ~200 clips.
 *   - FCP 7 XML import loses track mixer settings (EQ, volume, panner chain).
 *   - Direct injection: zero API calls, full fidelity, atomic file write.
 *
 * Empirically confirmed structure (I45 project, 2026-06-13):
 *   clip 1 (V+A) = 24 objects:
 *     Video: VideoClipTrackItem + VideoComponentChain + VideoFilterComponent
 *            + 11×ArbVideoComponentParam + SubClip + VideoClip
 *     Audio: AudioClipTrackItem + AudioComponentChain + AudioFilterComponent
 *            + 2×AudioComponentParam + SubClip + AudioClip + SecondaryContent
 *   Shared (never cloned): VideoMediaSource, AudioMediaSource, MarkerOwner
 *
 * Sequence template clone graph:
 *   Sequence → TrackGroups.Second (VideoTrackGroup, AudioTrackGroup, DataTrackGroup)
 *   VideoTrackGroup → TrackGroup.Tracks.Track (ObjectURef → VideoClipTrack)
 *                   → ComponentOwner.Components (VideoComponentChain)
 *   AudioTrackGroup → TrackGroup.Tracks.Track (ObjectURef → AudioClipTrack)
 *                   → MasterTrack (AudioMixTrack)
 *                       → AudioTrack.ComponentOwner.Components (AudioComponentChain)
 *                       → AudioTrack.Panner (pan processor)
 *                       → Inlet (AudioTrackInlet)
 *   AudioClipTrack  → AudioTrack.ComponentOwner.Components (AudioComponentChain)
 *                   → AudioTrack.Panner (pan processor)
 *   DataTrackGroup  → cloned as-is (no track items)
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
  /** name of the sequence to clone as template */
  templateSequenceName: string;
  /** name for the new injected sequence */
  newSequenceName: string;
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

/**
 * Get the tag name for an ObjectUID.
 */
function tagForUid(xml: string, uid: string): string | null {
  const marker = `ObjectUID="${uid}"`;
  const idx = xml.indexOf(marker);
  if (idx === -1) return null;
  let start = idx - 1;
  while (start > 0 && xml[start] !== "<") start--;
  const tagPart = xml.slice(start + 1, idx).trim();
  return tagPart.split(/\s+/)[0] ?? null;
}

/** Parse all numeric ObjectIDs in the XML (excludes those inside CDATA-like escaped blocks). */
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

// ── sequence subgraph walker ───────────────────────────────────────────────

/**
 * Classes of objects that are shared across sequences / media and must NOT
 * be cloned — we keep ObjectRefs to them unchanged.
 */
const SHARED_CLASSES = new Set([
  "VideoMediaSource",
  "AudioMediaSource",
  "MarkerOwner",
  "Markers",
  "ImporterPrefs",
  "MediaFilePath",
  "FormatObject",
  "LoggingInfo",
  "AudioClipChannelGroups",
  "AudioComponentChain", // MasterClip-level chains (those are inside MasterClip)
  // ^ clip-level AudioComponentChains ARE cloned (they are ObjectRef'd from ClipTrackItem)
  // We distinguish by whether we reach them from Sequence graph walk
]);

// Actually we should not use tag-based exclusion for AudioComponentChain because
// AudioClipTrack's per-track mixer chain IS part of what we want to clone.
// Let's use a more surgical stop set: only stop on well-known shared-media objects.
const STOP_TAGS = new Set([
  "VideoMediaSource",
  "AudioMediaSource",
  "MarkerOwner",
  "Markers",
  "ImporterPrefs",
  "Project",
  "RootProjectItem",
  "ProjectItem",
  "ClipProjectItem",
  "MasterClip",
  "LoggingInfo",
  "DefaultSequenceSettings",
  "ProjectSettings",
]);

interface WalkNode {
  type: "id" | "uid";
  value: string; // numeric string for id, GUID for uid
}

/**
 * BFS walk from a Sequence's ObjectUID.
 * Returns (ids: Set<number>, uids: Set<string>) of objects to clone.
 * Objects whose tags are in STOP_TAGS are NOT entered (they are shared).
 * Clip TrackItems are explicitly excluded — the new sequence starts empty.
 */
function walkSequenceSubgraph(
  xml: string,
  sequenceUid: string,
): { ids: number[]; uids: string[] } {
  const visitedIds = new Set<number>();
  const visitedUids = new Set<string>();
  const queue: WalkNode[] = [{ type: "uid", value: sequenceUid }];

  while (queue.length > 0) {
    const node = queue.shift()!;

    if (node.type === "uid") {
      if (visitedUids.has(node.value)) continue;
      visitedUids.add(node.value);

      const tag = tagForUid(xml, node.value);
      if (!tag || STOP_TAGS.has(tag)) continue;

      const block = extractElementByUid(xml, tag, node.value);
      if (!block) continue;

      // Enqueue children
      enqueueChildren(block, queue, visitedIds, visitedUids);
    } else {
      const id = parseInt(node.value, 10);
      if (visitedIds.has(id)) continue;
      visitedIds.add(id);

      const tag = tagForId(xml, id);
      if (!tag || STOP_TAGS.has(tag)) continue;

      const block = extractElement(xml, tag, id);
      if (!block) continue;

      enqueueChildren(block, queue, visitedIds, visitedUids);
    }
  }

  return {
    ids: Array.from(visitedIds),
    uids: Array.from(visitedUids),
  };
}

function enqueueChildren(
  block: string,
  queue: WalkNode[],
  visitedIds: Set<number>,
  visitedUids: Set<string>,
): void {
  // Collect ObjectRef="N" (numeric references)
  const refRe = /ObjectRef="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(block)) !== null) {
    const id = parseInt(m[1], 10);
    if (!visitedIds.has(id)) {
      queue.push({ type: "id", value: m[1] });
    }
  }
  // Collect ObjectURef="GUID" (GUID references)
  const urefRe = /ObjectURef="([0-9a-f-]{36})"/g;
  while ((m = urefRe.exec(block)) !== null) {
    const uid = m[1];
    if (!visitedUids.has(uid)) {
      queue.push({ type: "uid", value: uid });
    }
  }
}

// ── clip injection ─────────────────────────────────────────────────────────

/**
 * Find VideoMediaSource and AudioMediaSource ObjectIDs for a media path.
 * Searches by file path string. Returns null if not found.
 */
function findMediaSourceIds(
  xml: string,
  mediaPath: string,
): { videoSourceId: number | null; audioSourceId: number | null } {
  const baseName = path.basename(mediaPath);
  // Find any VideoMediaSource near the media path
  const pathPattern = new RegExp(
    `<VideoMediaSource ObjectID="(\\d+)"[^>]*>.*?${escapeRegex(baseName)}.*?</VideoMediaSource>`,
    "s",
  );
  const vm = pathPattern.exec(xml);
  const videoSourceId = vm ? parseInt(vm[1], 10) : null;

  const pathPattern2 = new RegExp(
    `<AudioMediaSource ObjectID="(\\d+)"[^>]*>.*?${escapeRegex(baseName)}.*?</AudioMediaSource>`,
    "s",
  );
  const am = pathPattern2.exec(xml);
  const audioSourceId = am ? parseInt(am[1], 10) : null;

  return { videoSourceId, audioSourceId };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the ObjectIDs of any Markers / MarkerOwner associated with the template
 * clips — we reuse these for new clips.
 */
function findSharedMarkerOwnerId(xml: string, seqUid: string): number | null {
  // The template clips reference a MarkerOwner; find by walking one VideoClip
  // in the FCP_XML_TEST sequence (or any existing VideoClip that uses the same source).
  const m = /MarkerOwner ObjectID="(\d+)"/.exec(xml);
  return m ? parseInt(m[1], 10) : null;
}

// ── template clip block extraction ────────────────────────────────────────

interface TemplateClipIds {
  videoTrackItemId: number;
  videoComponentChainId: number;
  videoFilterComponentId: number;
  videoFilterParamIds: number[];
  videoSubClipId: number;
  videoClipId: number;
  audioTrackItemId: number;
  audioComponentChainId: number;
  audioFilterComponentId: number;
  audioFilterParamIds: number[];
  audioSubClipId: number;
  audioClipId: number;
  secondaryContentId: number;
  videoMediaSourceId: number;
  audioMediaSourceId: number;
  markerOwnerId: number;
}

/**
 * Extract template clip IDs from an existing VideoClipTrackItem + AudioClipTrackItem pair.
 * Reads from the last (highest-index) pair in the given track item lists.
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

  // Parse VideoClipTrackItem
  const vItemBlock = extractElement(xml, "VideoClipTrackItem", lastVItemId);
  if (!vItemBlock) return null;
  const vChainRef = /Components ObjectRef="(\d+)"/.exec(vItemBlock);
  const vSubClipRef = /SubClip ObjectRef="(\d+)"/.exec(vItemBlock);
  if (!vChainRef || !vSubClipRef) return null;
  const videoComponentChainId = parseInt(vChainRef[1], 10);
  const videoSubClipId = parseInt(vSubClipRef[1], 10);

  // Parse VideoComponentChain → VideoFilterComponent → params
  const vChainBlock = extractElement(xml, "VideoComponentChain", videoComponentChainId);
  if (!vChainBlock) return null;
  const vFilterRef = /Component Index="0" ObjectRef="(\d+)"/.exec(vChainBlock);
  if (!vFilterRef) return null;
  const videoFilterComponentId = parseInt(vFilterRef[1], 10);

  const vFilterBlock = extractElement(xml, "VideoFilterComponent", videoFilterComponentId);
  if (!vFilterBlock) return null;
  const vParamRefs = [...vFilterBlock.matchAll(/Param Index="\d+" ObjectRef="(\d+)"/g)].map((m) =>
    parseInt(m[1], 10),
  );

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

  // AudioComponentChain → AudioFilterComponent → params
  const aChainBlock = extractElement(xml, "AudioComponentChain", audioComponentChainId);
  if (!aChainBlock) return null;
  const aFilterRef = /Component Index="0" ObjectRef="(\d+)"/.exec(aChainBlock);
  if (!aFilterRef) return null;
  const audioFilterComponentId = parseInt(aFilterRef[1], 10);

  const aFilterBlock = extractElement(xml, "AudioFilterComponent", audioFilterComponentId);
  if (!aFilterBlock) return null;
  const aParamRefs = [...aFilterBlock.matchAll(/Param Index="\d+" ObjectRef="(\d+)"/g)].map((m) =>
    parseInt(m[1], 10),
  );

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
  const secContentItemRef = /SecondaryContentItem Index="0" ObjectRef="(\d+)"/.exec(aClipBlock);
  if (!secContentItemRef) return null;
  const secondaryContentId = parseInt(secContentItemRef[1], 10);

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
    secondaryContentId,
    videoMediaSourceId,
    audioMediaSourceId,
    markerOwnerId,
  };
}

// ── remap helpers ─────────────────────────────────────────────────────────

/**
 * Apply ID remapping + GUID substitution to a cloned XML block.
 * old→new for both ObjectID and ObjectRef attributes.
 */
function remapBlock(
  block: string,
  idMap: Map<number, number>,
  uidMap: Map<string, string>,
): string {
  let result = block;

  // Remap ObjectID / ObjectRef (numeric) — longest ID first to avoid partial matches
  const sortedIds = [...idMap.entries()].sort((a, b) => b[0] - a[0]);
  for (const [oldId, newId] of sortedIds) {
    result = result.replaceAll(`ObjectID="${oldId}"`, `ObjectID="${newId}"`);
    result = result.replaceAll(`ObjectRef="${oldId}"`, `ObjectRef="${newId}"`);
  }

  // Remap ObjectUID / ObjectURef (GUIDs)
  for (const [oldUid, newUid] of uidMap.entries()) {
    result = result.replaceAll(`ObjectUID="${oldUid}"`, `ObjectUID="${newUid}"`);
    result = result.replaceAll(`ObjectURef="${oldUid}"`, `ObjectURef="${newUid}"`);
    // Also raw GUID occurrences (e.g. <ID>, <First> in TrackGroups)
    result = result.replaceAll(oldUid, newUid);
  }

  return result;
}

// ── main injection entry point ─────────────────────────────────────────────

export async function injectClips(options: InjectOptions): Promise<InjectResult> {
  const {
    prprojPath,
    templateSequenceName,
    newSequenceName,
    mediaPath,
    clips,
    debug = false,
  } = options;

  if (!fs.existsSync(prprojPath)) throw new Error(`prproj not found: ${prprojPath}`);
  if (clips.length === 0) throw new Error("clips array is empty");

  // ── 1. Decompress ──────────────────────────────────────────────────────────
  let xml = gunzipSync(prprojPath);

  // ── 2. Find template sequence ─────────────────────────────────────────────
  const tmplSeqMatch = new RegExp(
    `<Sequence ObjectUID="([0-9a-f-]{36})"[^>]*>.*?<Name>${escapeRegex(templateSequenceName)}</Name>.*?</Sequence>`,
    "s",
  ).exec(xml);
  if (!tmplSeqMatch) {
    throw new Error(`Template sequence "${templateSequenceName}" not found in project`);
  }
  const templateSeqUid = tmplSeqMatch[1];

  // ── 3. Find template sequence's V1/A1 track UIDs ─────────────────────────
  const tmplSeqBlock = tmplSeqMatch[0];
  const vTrackGroupRef = /Second ObjectRef="(\d+)"/.exec(tmplSeqBlock);
  if (!vTrackGroupRef) throw new Error("Template sequence: VideoTrackGroup ObjectRef not found");
  const vTrackGroupId = parseInt(vTrackGroupRef[1], 10);

  const vTrackGroupBlock = extractElement(xml, "VideoTrackGroup", vTrackGroupId);
  if (!vTrackGroupBlock) throw new Error("VideoTrackGroup not found for template");
  const v1TrackUidMatch = /Track Index="0" ObjectURef="([0-9a-f-]{36})"/.exec(vTrackGroupBlock);
  if (!v1TrackUidMatch) throw new Error("V1 track ObjectURef not found in VideoTrackGroup");
  const v1TrackUid = v1TrackUidMatch[1];

  // Audio track group — second TrackGroup entry (index 1 typically)
  // The sequence block has TrackGroups with up to 3 entries (V, A, Data)
  const trackGroupEntries = [...tmplSeqBlock.matchAll(/Second ObjectRef="(\d+)"/g)];
  if (trackGroupEntries.length < 2) throw new Error("Template sequence: AudioTrackGroup ref not found");
  const aTrackGroupId = parseInt(trackGroupEntries[1][1], 10);
  const aTrackGroupBlock = extractElement(xml, "AudioTrackGroup", aTrackGroupId);
  if (!aTrackGroupBlock) throw new Error("AudioTrackGroup not found for template");
  const a1TrackUidMatch = /Track Index="0" ObjectURef="([0-9a-f-]{36})"/.exec(aTrackGroupBlock);
  if (!a1TrackUidMatch) throw new Error("A1 track ObjectURef not found in AudioTrackGroup");
  const a1TrackUid = a1TrackUidMatch[1];

  // ── 4. Extract template clip IDs ─────────────────────────────────────────
  const tmplClip = extractTemplateClipIds(xml, v1TrackUid, a1TrackUid);
  if (!tmplClip) throw new Error("Could not extract template clip object IDs");

  // ── 5. Verify media is already imported ──────────────────────────────────
  const { videoSourceId, audioSourceId } = findMediaSourceIds(xml, mediaPath);
  if (videoSourceId === null || audioSourceId === null) {
    throw new Error(
      `Media "${path.basename(mediaPath)}" not found in project. ` +
        `Import it into Premiere first, then run this command.`,
    );
  }
  // Verify the template clip uses the same source (cross-check)
  if (
    tmplClip.videoMediaSourceId !== videoSourceId ||
    tmplClip.audioMediaSourceId !== audioSourceId
  ) {
    // Different source — still OK, we override the source refs when building clips
    // but we need to know the correct media source IDs (which we already have)
  }

  // ── 6. Walk template sequence subgraph ────────────────────────────────────
  const { ids: tmplIds, uids: tmplUids } = walkSequenceSubgraph(xml, templateSeqUid);

  // ── 7. Assign new IDs / GUIDs ─────────────────────────────────────────────
  const existingIds = collectAllObjectIds(xml);
  // start from max+1 in the *full* xml scope, but we also need to track IDs we
  // allocate within this run to avoid collisions in batch allocation
  let nextId = maxObjectId(xml) + 1;

  const seqIdMap = new Map<number, number>();
  const seqUidMap = new Map<string, string>();

  for (const id of tmplIds) {
    seqIdMap.set(id, nextId++);
  }
  for (const uid of tmplUids) {
    seqUidMap.set(uid, newGuid());
  }

  // ── 8. Clone the sequence subgraph (without clip TrackItems) ──────────────
  const seqCloneBlocks: string[] = [];
  const newSeqUid = seqUidMap.get(templateSeqUid)!;

  for (const uid of tmplUids) {
    const tag = tagForUid(xml, uid);
    if (!tag || STOP_TAGS.has(tag)) continue;
    const block = extractElementByUid(xml, tag, uid);
    if (!block) continue;
    let remapped = remapBlock(block, seqIdMap, seqUidMap);
    // If this is the Sequence, update its Name
    if (uid === templateSeqUid) {
      remapped = remapped.replace(
        `<Name>${templateSequenceName}</Name>`,
        `<Name>${newSequenceName}</Name>`,
      );
      // Clear any TrackItems from the track blocks (template may have clips)
      // This is done below at the track level.
    }
    seqCloneBlocks.push(remapped);
  }
  for (const id of tmplIds) {
    const tag = tagForId(xml, id);
    if (!tag || STOP_TAGS.has(tag)) continue;
    const block = extractElement(xml, tag, id);
    if (!block) continue;
    let remapped = remapBlock(block, seqIdMap, seqUidMap);
    // Clear TrackItems from the cloned VideoClipTrack / AudioClipTrack
    if (tag === "VideoClipTrack" || tag === "AudioClipTrack") {
      remapped = remapped.replace(
        /<TrackItems Version="1">[\s\S]*?<\/TrackItems>/,
        '<TrackItems Version="1">\n\t\t\t\t\t</TrackItems>',
      );
    }
    seqCloneBlocks.push(remapped);
  }

  // Determine new V1 / A1 track UIDs (remapped from template)
  const newV1TrackUid = seqUidMap.get(v1TrackUid)!;
  const newA1TrackUid = seqUidMap.get(a1TrackUid)!;

  // ── 9. Build N×24 clip objects ────────────────────────────────────────────
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

    // Allocate IDs for this clip's 24 objects
    const newVItemId = nextId++;
    const newVChainId = nextId++;
    const newVFilterId = nextId++;
    const newVParamIds = tmplClip.videoFilterParamIds.map(() => nextId++);
    const newVSubClipId = nextId++;
    const newVClipId = nextId++;

    const newAItemId = nextId++;
    const newAChainId = nextId++;
    const newAFilterId = nextId++;
    const newAParamIds = tmplClip.audioFilterParamIds.map(() => nextId++);
    const newASubClipId = nextId++;
    const newAClipId = nextId++;
    const newSecContentId = nextId++;

    vTrackItemIds.push(newVItemId);
    aTrackItemIds.push(newAItemId);

    // Clone template blocks and remap
    const clipIdMap = new Map<number, number>([
      [tmplClip.videoTrackItemId, newVItemId],
      [tmplClip.videoComponentChainId, newVChainId],
      [tmplClip.videoFilterComponentId, newVFilterId],
      ...tmplClip.videoFilterParamIds.map((id, j): [number, number] => [id, newVParamIds[j]]),
      [tmplClip.videoSubClipId, newVSubClipId],
      [tmplClip.videoClipId, newVClipId],
      [tmplClip.audioTrackItemId, newAItemId],
      [tmplClip.audioComponentChainId, newAChainId],
      [tmplClip.audioFilterComponentId, newAFilterId],
      ...tmplClip.audioFilterParamIds.map((id, j): [number, number] => [id, newAParamIds[j]]),
      [tmplClip.audioSubClipId, newASubClipId],
      [tmplClip.audioClipId, newAClipId],
      [tmplClip.secondaryContentId, newSecContentId],
    ]);

    // We don't remap shared IDs (media sources, markers) — they stay the same
    const clipUidMap = new Map<string, string>();

    const buildClipBlock = (tag: string, id: number): string => {
      const block = extractElement(xml, tag, id);
      if (!block) throw new Error(`Template block missing: ${tag} ObjectID=${id}`);
      let remapped = remapBlock(block, clipIdMap, clipUidMap);
      // Fix media source refs to the actual media (in case template used different source)
      remapped = remapped.replaceAll(
        `ObjectRef="${tmplClip.videoMediaSourceId}"`,
        `ObjectRef="${videoSourceId}"`,
      );
      remapped = remapped.replaceAll(
        `ObjectRef="${tmplClip.audioMediaSourceId}"`,
        `ObjectRef="${audioSourceId}"`,
      );
      return remapped;
    };

    // VideoClipTrackItem — update timeline Start/End
    let vItem = buildClipBlock("VideoClipTrackItem", tmplClip.videoTrackItemId);
    vItem = replaceTimelinePosition(vItem, timelineStart, timelineEnd);

    // VideoClip — update source InPoint/OutPoint + new ClipID
    let vClip = buildClipBlock("VideoClip", tmplClip.videoClipId);
    vClip = vClip.replace(/<InPoint>\d+<\/InPoint>/, `<InPoint>${srcStartTicks}</InPoint>`);
    vClip = vClip.replace(/<OutPoint>\d+<\/OutPoint>/, `<OutPoint>${srcEndTicks}</OutPoint>`);
    vClip = vClip.replace(/<ClipID>[^<]+<\/ClipID>/, `<ClipID>${newGuid()}</ClipID>`);

    // AudioClipTrackItem — update timeline Start/End + new ID GUID
    let aItem = buildClipBlock("AudioClipTrackItem", tmplClip.audioTrackItemId);
    aItem = replaceTimelinePosition(aItem, timelineStart, timelineEnd);
    aItem = aItem.replace(/<ID>[0-9a-f-]{36}<\/ID>/, `<ID>${newGuid()}</ID>`);

    // AudioClip — update source InPoint/OutPoint + new ClipID
    let aClip = buildClipBlock("AudioClip", tmplClip.audioClipId);
    aClip = aClip.replace(/<InPoint>\d+<\/InPoint>/, `<InPoint>${srcStartTicks}</InPoint>`);
    aClip = aClip.replace(/<OutPoint>\d+<\/OutPoint>/, `<OutPoint>${srcEndTicks}</OutPoint>`);
    aClip = aClip.replace(/<ClipID>[^<]+<\/ClipID>/, `<ClipID>${newGuid()}</ClipID>`);

    const vChain = buildClipBlock("VideoComponentChain", tmplClip.videoComponentChainId);
    const vFilter = buildClipBlock("VideoFilterComponent", tmplClip.videoFilterComponentId);
    const vSubClip = buildClipBlock("SubClip", tmplClip.videoSubClipId);
    const aChain = buildClipBlock("AudioComponentChain", tmplClip.audioComponentChainId);
    const aFilter = buildClipBlock("AudioFilterComponent", tmplClip.audioFilterComponentId);
    const aSubClip = buildClipBlock("SubClip", tmplClip.audioSubClipId);
    const secContent = buildClipBlock("SecondaryContent", tmplClip.secondaryContentId);
    secContent; // silence unused (included in aClip's SecondaryContents block via remapping)

    const vFilterParams = tmplClip.videoFilterParamIds.map((id) => {
      const tag = tagForId(xml, id)!;
      return buildClipBlock(tag, id);
    });
    const aFilterParams = tmplClip.audioFilterParamIds.map((id) => {
      const tag = tagForId(xml, id)!;
      return buildClipBlock(tag, id);
    });

    clipBlocks.push(
      vItem,
      vChain,
      vFilter,
      ...vFilterParams,
      vSubClip,
      vClip,
      aItem,
      aChain,
      aFilter,
      ...aFilterParams,
      aSubClip,
      aClip,
      buildClipBlock("SecondaryContent", tmplClip.secondaryContentId),
    );
  }

  // ── 10. Update TrackItems lists in cloned V1/A1 tracks ───────────────────
  const vTrackItemsXml = vTrackItemIds
    .map((id, i) => `\t\t\t\t\t<TrackItem Index="${i}" ObjectRef="${id}"/>`)
    .join("\n");
  const aTrackItemsXml = aTrackItemIds
    .map((id, i) => `\t\t\t\t\t<TrackItem Index="${i}" ObjectRef="${id}"/>`)
    .join("\n");

  // Patch the cloned V1/A1 track blocks (they have empty TrackItems from step 8)
  const seqCloneXml = seqCloneBlocks
    .map((block) => {
      // Identify cloned VideoClipTrack for new V1
      if (block.includes(`ObjectUID="${newV1TrackUid}"`)) {
        return block.replace(
          /<TrackItems Version="1">\s*<\/TrackItems>/,
          `<TrackItems Version="1">\n${vTrackItemsXml}\n\t\t\t\t</TrackItems>`,
        );
      }
      if (block.includes(`ObjectUID="${newA1TrackUid}"`)) {
        return block.replace(
          /<TrackItems Version="1">\s*<\/TrackItems>/,
          `<TrackItems Version="1">\n${aTrackItemsXml}\n\t\t\t\t</TrackItems>`,
        );
      }
      return block;
    })
    .join("\n");

  // ── 11. Register new sequence in Root Bin (ClipProjectItem + MasterClip) ──
  // Pattern from I45: ClipProjectItem (ObjectUID) → MasterClip (ObjectUID)
  // MasterClip for a sequence just needs Name + a minimal structure
  const newMasterClipUid = newGuid();
  const newClipProjectItemUid = newGuid();

  // Find an existing LoggingInfo, AudioComponentChain, AudioClipChannelGroups ID to clone
  // for the MasterClip. We'll use a stub — Premiere sequences don't need full media metadata.
  const newLoggingInfoId = nextId++;
  const newAudioCompChainId = nextId++;
  const newAudioClipChGrpId = nextId++;

  // Clone LoggingInfo from an existing one (or create minimal stub)
  const existingLogBlock = extractElement(xml, "LoggingInfo", 78) ?? `\t<LoggingInfo ObjectID="${newLoggingInfoId}" ClassID="5c11c7c0-7698-11d5-af2d-9b7ef0a4ceb4" Version="2">\n\t</LoggingInfo>`;
  const newLogBlock = existingLogBlock.replace(
    /ObjectID="\d+"/,
    `ObjectID="${newLoggingInfoId}"`,
  );

  // Minimal AudioComponentChain for MasterClip
  const newAudioCompChainBlock = `\t<AudioComponentChain ObjectID="${newAudioCompChainId}" ClassID="3cb131d1-d3c0-47ae-a19a-bdf75ea11674" Version="4">
\t\t<ComponentChain Version="3">
\t\t</ComponentChain>
\t</AudioComponentChain>`;

  // Minimal AudioClipChannelGroups
  const newAudioClipChGrpBlock = `\t<AudioClipChannelGroups ObjectID="${newAudioClipChGrpId}" ClassID="6d5949b5-97bc-4f57-a9c5-3c68e1c9f3ca" Version="1">
\t</AudioClipChannelGroups>`;

  // Find existing Clip IDs for MasterClip.Clips — for a sequence, use 2 minimal VideoClip stubs
  // Actually: for sequence MasterClips in I45, they have Clips[0,1] pointing to
  // VideoClip / AudioClip objects. We keep it minimal — just reference something plausible.
  // The simpler approach: don't create Clip entries (the MasterClip for FCP_XML_TEST
  // has Clip 0→VideoClip, 1→AudioClip). For our new sequence, we'll add a stub.
  const newMcVideoClipId = nextId++;
  const newMcAudioClipId = nextId++;

  const newMcVideoClipBlock = `\t<VideoClip ObjectID="${newMcVideoClipId}" ClassID="9308dbef-2440-4acb-9ab2-953b9a4e82ec" Version="11">
\t\t<Clip Version="18">
\t\t\t<MarkerOwner Version="1">
\t\t\t\t<Markers ObjectRef="${tmplClip.markerOwnerId}"/>
\t\t\t</MarkerOwner>
\t\t\t<Source ObjectRef="${videoSourceId}"/>
\t\t\t<InPoint>0</InPoint>
\t\t\t<OutPoint>0</OutPoint>
\t\t\t<ClipID>${newGuid()}</ClipID>
\t\t</Clip>
\t\t<PosterFrame>0</PosterFrame>
\t</VideoClip>`;

  const newMcAudioClipBlock = `\t<AudioClip ObjectID="${newMcAudioClipId}" ClassID="b8830d03-de02-41ee-84ec-fe566dc70cd9" Version="8">
\t\t<Clip Version="18">
\t\t\t<MarkerOwner Version="1">
\t\t\t\t<Markers ObjectRef="${tmplClip.markerOwnerId}"/>
\t\t\t</MarkerOwner>
\t\t\t<Source ObjectRef="${audioSourceId}"/>
\t\t\t<InPoint>0</InPoint>
\t\t\t<OutPoint>0</OutPoint>
\t\t\t<ClipID>${newGuid()}</ClipID>
\t\t</Clip>
\t\t<AudioChannelLayout>[{"channellabel":0}]</AudioChannelLayout>
\t</AudioClip>`;

  const newMasterClipBlock = `\t<MasterClip ObjectUID="${newMasterClipUid}" ClassID="fb11c33a-b0a9-4465-aa94-b6d5db2628cf" Version="12">
\t\t<LoggingInfo ObjectRef="${newLoggingInfoId}"/>
\t\t<AudioComponentChains Version="1">
\t\t\t<AudioComponentChain Index="0" ObjectRef="${newAudioCompChainId}"/>
\t\t</AudioComponentChains>
\t\t<Clips Version="1">
\t\t\t<Clip Index="0" ObjectRef="${newMcVideoClipId}"/>
\t\t\t<Clip Index="1" ObjectRef="${newMcAudioClipId}"/>
\t\t</Clips>
\t\t<AudioClipChannelGroups ObjectRef="${newAudioClipChGrpId}"/>
\t\t<Name>${newSequenceName}</Name>
\t\t<MasterClipChangeVersion>1</MasterClipChangeVersion>
\t</MasterClip>`;

  const newClipProjectItemBlock = `\t<ClipProjectItem ObjectUID="${newClipProjectItemUid}" ClassID="cb4e0ed7-aca1-4171-8525-e3658dec06dd" Version="1">
\t\t<ProjectItem Version="1">
\t\t\t<Node Version="1">
\t\t\t\t<Properties Version="1">
\t\t\t\t</Properties>
\t\t\t</Node>
\t\t\t<Name>${newSequenceName}</Name>
\t\t</ProjectItem>
\t\t<MasterClip ObjectURef="${newMasterClipUid}"/>
\t</ClipProjectItem>`;

  // ── 12. Add new sequence to Root Bin Items ────────────────────────────────
  // Find the last Item in Root Bin Items list and append after it
  const rootBinItemsMatch = /<RootProjectItem ObjectUID="[0-9a-f-]{36}"[\s\S]*?<\/RootProjectItem>/.exec(xml);
  if (!rootBinItemsMatch) throw new Error("RootProjectItem not found");
  const rootBinBlock = rootBinItemsMatch[0];

  // Find the last Item Index in Items Version="1"
  const itemsMatch = /<Items Version="1">([\s\S]*?)<\/Items>/.exec(rootBinBlock);
  if (!itemsMatch) throw new Error("Root Bin Items not found");
  const lastItemMatch = [...itemsMatch[1].matchAll(/Item Index="(\d+)"/g)].pop();
  const lastItemIndex = lastItemMatch ? parseInt(lastItemMatch[1], 10) : -1;
  const newItemIndex = lastItemIndex + 1;

  const newItemEntry = `\t\t\t\t<Item Index="${newItemIndex}" ObjectURef="${newClipProjectItemUid}"/>`;
  const updatedRootBin = rootBinBlock.replace(
    /<\/Items>\s*<\/ProjectItemContainer>/,
    `${newItemEntry}\n\t\t\t</Items>\n\t\t</ProjectItemContainer>`,
  );
  xml = xml.replace(rootBinBlock, updatedRootBin);

  // ── 13. Determine insertion anchor (adjacent to last clip block) ──────────
  // Find the last AudioClipTrackItem in the template sequence (L099 anchor)
  const lastAItemTag = "AudioClipTrackItem";
  const lastAItemId = tmplClip.audioTrackItemId;
  const lastAItemBlock = extractElement(xml, lastAItemTag, lastAItemId);
  if (!lastAItemBlock) throw new Error("Could not find last AudioClipTrackItem for insertion anchor");

  // Build all new XML content
  const registrationBlocks = [
    newLogBlock,
    newAudioCompChainBlock,
    newAudioClipChGrpBlock,
    newMcVideoClipBlock,
    newMcAudioClipBlock,
    newMasterClipBlock,
    newClipProjectItemBlock,
  ].join("\n");

  const allNewBlocks =
    seqCloneXml + "\n" + clipBlocks.join("\n") + "\n" + registrationBlocks;

  // Insert adjacent to the last audio clip track item in the template sequence
  xml = xml.replace(lastAItemBlock, lastAItemBlock + "\n" + allNewBlocks);

  // ── 14. Self-validation ───────────────────────────────────────────────────
  const validation = selfValidate(xml, newV1TrackUid, newA1TrackUid, clips.length, nextId - 1);

  // ── 15. Write output ──────────────────────────────────────────────────────
  const backupPath = prprojPath + ".bak";
  fs.copyFileSync(prprojPath, backupPath);
  gzipWriteSync(prprojPath, xml);

  let debugPath: string | undefined;
  if (debug) {
    debugPath = prprojPath + ".inject-debug.json";
    const debugData = {
      templateSequenceName,
      newSequenceName,
      templateSeqUid,
      newSeqUid,
      newV1TrackUid,
      newA1TrackUid,
      seqIdRemapping: Object.fromEntries(seqIdMap),
      seqUidRemapping: Object.fromEntries(seqUidMap),
      clipCount: clips.length,
      objectsCreated: nextId - (maxObjectId(gunzipSync(backupPath)) + 1) + 1,
      validation,
    };
    fs.writeFileSync(debugPath, JSON.stringify(debugData, null, 2));
  }

  return {
    outputPath: prprojPath,
    backupPath,
    debugPath,
    clipsInjected: clips.length,
    objectsCreated: seqIdMap.size + seqUidMap.size + clips.length * 24 + 7,
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
