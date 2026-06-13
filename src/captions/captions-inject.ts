/**
 * captions-inject.ts
 *
 * Injects N caption track items directly into an existing caption track of a
 * sequence in a .prproj file (gzipped XML) — no UXP API round-trips.
 *
 * Mirror of cut/prproj-inject.ts (clip injection). Same mechanism, applied to
 * the caption object graph instead of the video/audio clip graph.
 *
 * Why this approach (L111):
 *   - The caption TrackItem chain is self-contained: each caption owns its own
 *     SubClip / MasterClip / Block, so cloning one caption pulls a clean tree
 *     (the shared CaptionCollection is never referenced from the item chain).
 *   - Direct injection: zero API calls, full fidelity, atomic file write.
 *
 * Caption object chain (L111), near 1:1 with the cut clip chain:
 *   CaptionDataClipTrack            (the track, one per sequence's DataTrackGroup)
 *    └ TrackItems > TrackItem ObjectRef → CaptionDataClipTrackItem
 *        ├ Components ObjectRef → DataComponentChain   (empty stub; cloned)
 *        ├ End / Start ticks                            (timeline position)
 *        ├ SubClip ObjectRef → SubClip "SyntheticCaption"
 *        │    ├ Clip ObjectRef → TranscriptClip         (Source shared, In/OutPoint)
 *        │    └ MasterClip ObjectURef                   (SHARED — not cloned)
 *        └ BlockVector > BlockVectorItem ObjectRef → Block
 *             └ FormattedTextData (base64 FlatBuffer; caption text lives here)
 *
 * Clone 5 objects per caption: CaptionDataClipTrackItem, DataComponentChain,
 * SubClip, Block, TranscriptClip. SHARE MasterClip (ObjectURef) and the
 * TranscriptClip's Source (ObjectRef).
 *
 * CRITICAL (L107): NEVER create a new CaptionDataClipTrack object — that
 * corrupts the project ("project is damaged and cannot be opened"). We only
 * append TrackItem refs into an EXISTING caption track and insert the cloned
 * objects adjacent to the donor anchor (L099 — inserting at </PremiereData>
 * makes Premiere silently discard them).
 *
 * Proven by the cap_spike experiments (2026-06-13): donor-clone injection
 * opened cleanly in Premiere 26.0 and rendered; arbitrary-length base64 text
 * rewrite (re-pad) rendered correctly. See lesson.md L111.
 */

import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";

export const TICKS_PER_SECOND = 254016000000n;

export interface CaptionRange {
  /** timeline start in seconds */
  startSec: number;
  /** timeline end in seconds */
  endSec: number;
  /** caption text (UTF-8) */
  text: string;
}

export interface InjectCaptionsOptions {
  /** path to the .prproj file (gzipped XML) */
  prprojPath: string;
  /** name of the sequence whose caption track receives the items */
  targetSequenceName: string;
  /** captions to place: absolute timeline ranges + text */
  captions: CaptionRange[];
  /**
   * Which caption track in the sequence's DataTrackGroup to inject into,
   * when the sequence has more than one. Default: the first caption track
   * that already has at least one item (the donor track).
   */
  captionTrackIndex?: number;
  /** write a debug JSON beside the prproj (default false) */
  debug?: boolean;
}

export interface InjectCaptionsResult {
  /** absolute path to the written .prproj file */
  outputPath: string;
  /** absolute path to the .bak backup */
  backupPath: string;
  /** absolute path to debug JSON (only if debug:true) */
  debugPath?: string;
  /** number of captions injected */
  captionsInjected: number;
  /** total new objects written (= captionsInjected * 5) */
  objectsCreated: number;
  /** ObjectUID of the caption track that received the items */
  captionTrackUid: string;
  /** self-validation results */
  validation: CaptionValidationResult;
}

export interface CaptionValidationResult {
  wellFormed: boolean;
  allRefsResolved: boolean;
  newIdDuplicates: boolean;
  captionTrackItemCount: number;
  expectedCaptionCount: number;
  /** existing item count before injection */
  priorItemCount: number;
  passed: boolean;
  errors: string[];
}

// ── low-level helpers (shared shape with cut/prproj-inject.ts) ───────────────

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
 * Extract a single element block by tag + ObjectID.
 * Handles full elements (<Tag ...>...</Tag>) and self-closing (<Tag .../>).
 */
function extractElement(xml: string, tag: string, objectId: number): string | null {
  const pattern = new RegExp(`\t<${tag} ObjectID="${objectId}"[^>]*>.*?<\\/${tag}>`, "s");
  const m = pattern.exec(xml);
  if (m) return m[0];
  const pattern2 = new RegExp(`\t<${tag} ObjectID="${objectId}"[^/]*/>`);
  const m2 = pattern2.exec(xml);
  if (m2) return m2[0];
  return null;
}

/** Extract a top-level element by ObjectUID (GUID). */
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

/** Apply old→new ObjectID/ObjectRef remapping to a cloned XML block. */
function remapBlock(block: string, idMap: Map<number, number>): string {
  let result = block;
  // longest ID first to avoid partial matches (e.g. 14 inside 14396)
  const sortedIds = [...idMap.entries()].sort((a, b) => b[0] - a[0]);
  for (const [oldId, newId] of sortedIds) {
    result = result.replaceAll(`ObjectID="${oldId}"`, `ObjectID="${newId}"`);
    result = result.replaceAll(`ObjectRef="${oldId}"`, `ObjectRef="${newId}"`);
  }
  return result;
}

// ── sequence lookup ──────────────────────────────────────────────────────────

/** Find a sequence block by name. Returns { uid, block } or null. */
function findSequenceByName(xml: string, name: string): { uid: string; block: string } | null {
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

/** Decompress a .prproj and check if the named sequence exists. */
export function sequenceExistsInPrproj(prprojPath: string, name: string): boolean {
  const xml = gunzipSync(prprojPath);
  return findSequenceByName(xml, name) !== null;
}

/**
 * Resolve the caption track(s) of a sequence.
 *
 * Linkage (confirmed empirically, I35 backup): a Sequence has three
 * `Second ObjectRef` entries in order [VideoTrackGroup, AudioTrackGroup,
 * DataTrackGroup]. The DataTrackGroup's `<Tracks>` lists the caption tracks
 * via `Track Index="i" ObjectURef="<uid>"`. A sequence may have a
 * DataTrackGroup with NO `<Tracks>` element at all — that is the
 * "no caption track" case.
 */
function findCaptionTracks(
  xml: string,
  seqBlock: string,
): { uid: string; itemCount: number }[] {
  const secondRefs = [...seqBlock.matchAll(/<Second ObjectRef="(\d+)"\/>/g)].map((m) =>
    parseInt(m[1], 10),
  );
  // DataTrackGroup is the third track group (index 2)
  if (secondRefs.length < 3) return [];
  const dataGroupId = secondRefs[2];
  const dataGroupBlock = extractElement(xml, "DataTrackGroup", dataGroupId);
  if (!dataGroupBlock) return [];

  const trackUids = [...dataGroupBlock.matchAll(/Track Index="\d+" ObjectURef="([0-9a-f-]{36})"/g)].map(
    (m) => m[1],
  );

  const result: { uid: string; itemCount: number }[] = [];
  for (const uid of trackUids) {
    const trackBlock = extractElementByUid(xml, "CaptionDataClipTrack", uid);
    if (!trackBlock) continue; // not a caption track (e.g. a transcript track)
    const itemCount = (trackBlock.match(/<TrackItem Index="\d+" ObjectRef="\d+"/g) ?? []).length;
    result.push({ uid, itemCount });
  }
  return result;
}

// ── donor caption chain ──────────────────────────────────────────────────────

interface DonorCaptionIds {
  trackItemId: number;
  componentChainId: number;
  subClipId: number;
  transcriptClipId: number;
  blockId: number;
}

/**
 * Resolve the full caption chain from a CaptionDataClipTrackItem ObjectID.
 * The MasterClip (ObjectURef) and the TranscriptClip's Source (ObjectRef) are
 * deliberately NOT collected — they are shared, not cloned.
 */
function resolveCaptionChain(xml: string, trackItemId: number): DonorCaptionIds | null {
  const itemBlock = extractElement(xml, "CaptionDataClipTrackItem", trackItemId);
  if (!itemBlock) return null;

  const compRef = /Components ObjectRef="(\d+)"/.exec(itemBlock);
  const subRef = /SubClip ObjectRef="(\d+)"/.exec(itemBlock);
  const blockRef = /BlockVectorItem Index="0" ObjectRef="(\d+)"/.exec(itemBlock);
  if (!compRef || !subRef || !blockRef) return null;
  const componentChainId = parseInt(compRef[1], 10);
  const subClipId = parseInt(subRef[1], 10);
  const blockId = parseInt(blockRef[1], 10);

  const subBlock = extractElement(xml, "SubClip", subClipId);
  if (!subBlock) return null;
  const clipRef = /Clip ObjectRef="(\d+)"/.exec(subBlock);
  if (!clipRef) return null;
  const transcriptClipId = parseInt(clipRef[1], 10);

  // Sanity: the referenced clip must be a TranscriptClip with a Source ref.
  const transcriptBlock = extractElement(xml, "TranscriptClip", transcriptClipId);
  if (!transcriptBlock) return null;
  if (!/Source ObjectRef="\d+"/.test(transcriptBlock)) return null;

  return { trackItemId, componentChainId, subClipId, transcriptClipId, blockId };
}

// ── FlatBuffer tail-string rewrite (the only new logic vs. cut) ──────────────

/**
 * Rewrite the caption text inside a decoded Block FlatBuffer buffer.
 *
 * Layout of the trailing string (proven by make_text{E,F}.py, L111):
 *   [uint32 LE length][utf8 bytes][null terminator][pad so (len+1)%4==0]
 *
 * The text sits at the BUFFER TAIL, so changing its length does NOT cascade
 * any earlier offsets/vtables — we just rewrite the length field, the utf8
 * bytes, and recompute the trailing null+pad. BinaryHash is not validated by
 * Premiere and is left untouched.
 *
 * The donor text is located generically (we do not know it in advance): from
 * the buffer end, skip trailing 0x00 (terminator + pad); the preceding utf8
 * run is the string IFF the uint32 LE at (textStart-4) equals that run's byte
 * length. This uniquely identifies the [len][utf8][null][pad] tail.
 *
 * Returns the new buffer. Throws if the tail does not match the expected
 * layout (so a malformed donor fails loudly instead of corrupting the file).
 */
export function rewriteCaptionTextBuffer(data: Buffer, newText: string): Buffer {
  const newBytes = Buffer.from(newText, "utf8");

  // Walk back over trailing null bytes (terminator + alignment pad).
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  // `end` is now one past the last non-null byte = end of the utf8 run.
  const textEnd = end;

  // Find the start of the utf8 run by validating the length prefix. We don't
  // know the run length yet, so we trust the uint32 length field: scan back
  // for a 4-byte boundary whose LE uint32 equals (textEnd - candidateStart).
  // In practice the field is exactly at textStart-4, so derive textStart from
  // the field, then verify.
  //
  // Read the length field assuming the run is contiguous: the field is the
  // 4 bytes immediately preceding the run. We locate the run start by reading
  // every plausible length field is overkill — instead, read the uint32 at
  // each position p where the run [p .. textEnd) could begin, i.e. the field
  // is at p-4 and must equal (textEnd - p). The donor always satisfies this at
  // exactly one p, so search from the smallest plausible run outward is not
  // needed: solve directly. lenField = textEnd - textStart, and field sits at
  // textStart-4. So for the correct textStart: u32(textStart-4) == textEnd-textStart.
  let textStart = -1;
  // The string can contain 0x00? No — it's a null-terminated utf8 string, so
  // the run has no interior nulls. Therefore the run start is bounded by the
  // previous null OR the length field. Scan backwards to the previous 0x00.
  let runStart = textEnd;
  while (runStart > 0 && data[runStart - 1] !== 0) runStart--;
  // Candidate textStart is runStart; verify the length field at runStart-4.
  if (runStart >= 4) {
    const lenField = data.readUInt32LE(runStart - 4);
    if (lenField === textEnd - runStart) {
      textStart = runStart;
    }
  }
  if (textStart < 0) {
    throw new Error(
      "caption Block tail does not match [uint32 len][utf8][null][pad] layout — donor Block is not a simple tail string",
    );
  }

  const lenFieldPos = textStart - 4;
  const newLen = newBytes.length;
  const newPad = (4 - ((newLen + 1) % 4)) % 4;
  const newNullPad = Buffer.alloc(1 + newPad); // null terminator + alignment pad

  const head = data.subarray(0, lenFieldPos);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(newLen, 0);

  return Buffer.concat([head, lenBuf, newBytes, newNullPad]);
}

/**
 * Rewrite the FormattedTextData base64 of a cloned Block XML to `newText`.
 * Returns the new Block XML string.
 */
function rewriteBlockText(blockXml: string, newText: string): string {
  const m = /(FormattedTextData[^>]*>\s*)([A-Za-z0-9+/=]+)/.exec(blockXml);
  if (!m) throw new Error("cloned Block has no FormattedTextData base64 payload");
  const b64 = m[2];
  const data = Buffer.from(b64, "base64");
  const newData = rewriteCaptionTextBuffer(data, newText);
  const newB64 = newData.toString("base64");
  return blockXml.replace(b64, newB64);
}

// ── caption timeline position ────────────────────────────────────────────────

/**
 * Set both <Start> and <End> on a cloned CaptionDataClipTrackItem.
 * Captions are absolute, independent placements (unlike the cut tiling case),
 * so we value-replace each field. In the caption XML <End> precedes <Start>.
 * No frame-grid snapping — caption positions need not be frame-aligned.
 */
function setCaptionPosition(itemXml: string, startTicks: bigint, endTicks: bigint): string {
  let result = itemXml;
  result = result.replace(/<End>\d+<\/End>/, `<End>${endTicks}</End>`);
  result = result.replace(/<Start>\d+<\/Start>/, `<Start>${startTicks}</Start>`);
  return result;
}

// ── main injection entry point ───────────────────────────────────────────────

export async function injectCaptions(
  options: InjectCaptionsOptions,
): Promise<InjectCaptionsResult> {
  const { prprojPath, targetSequenceName, captions, captionTrackIndex, debug = false } = options;

  if (!fs.existsSync(prprojPath)) throw new Error(`prproj not found: ${prprojPath}`);
  if (captions.length === 0) throw new Error("captions array is empty");

  // ── 1. Decompress ──────────────────────────────────────────────────────────
  let xml = gunzipSync(prprojPath);

  // ── 2. Find target sequence ────────────────────────────────────────────────
  const seqFound = findSequenceByName(xml, targetSequenceName);
  if (!seqFound) {
    throw new Error(
      `Sequence "${targetSequenceName}" not found in project. ` +
        `Open the project in Premiere and check the sequence name.`,
    );
  }

  // ── 3. Resolve the caption track ───────────────────────────────────────────
  const captionTracks = findCaptionTracks(xml, seqFound.block);
  if (captionTracks.length === 0) {
    throw new Error(
      `Sequence "${targetSequenceName}" has no caption track. ` +
        `Add at least one caption to it in Premiere first (Window > Text > Captions), ` +
        `then re-run. Creating a caption track here would corrupt the project (L107).`,
    );
  }

  // Pick the target track. Explicit index wins; otherwise the first track that
  // already has items (so we have a donor to clone). A caption track with zero
  // items has no donor chain and cannot be used as a clone source.
  let target: { uid: string; itemCount: number } | undefined;
  if (captionTrackIndex !== undefined) {
    target = captionTracks[captionTrackIndex];
    if (!target) {
      throw new Error(
        `captionTrackIndex ${captionTrackIndex} out of range — sequence has ` +
          `${captionTracks.length} caption track(s).`,
      );
    }
    if (target.itemCount === 0) {
      throw new Error(
        `Caption track index ${captionTrackIndex} is empty (no donor caption to clone). ` +
          `Add a caption to that track in Premiere first, or pick a non-empty track.`,
      );
    }
  } else {
    target = captionTracks.find((t) => t.itemCount > 0);
    if (!target) {
      throw new Error(
        `Sequence "${targetSequenceName}" has caption track(s) but all are empty ` +
          `(no donor caption to clone). Add at least one caption in Premiere first.`,
      );
    }
  }
  const captionTrackUid = target.uid;
  const priorItemCount = target.itemCount;

  // ── 4. Resolve the donor caption chain (last item on the target track) ─────
  const trackBlock = extractElementByUid(xml, "CaptionDataClipTrack", captionTrackUid);
  if (!trackBlock) throw new Error("caption track block vanished after lookup (internal error)");
  const itemRefs = [...trackBlock.matchAll(/<TrackItem Index="\d+" ObjectRef="(\d+)"/g)].map((m) =>
    parseInt(m[1], 10),
  );
  const donorItemId = itemRefs[itemRefs.length - 1];
  const donor = resolveCaptionChain(xml, donorItemId);
  if (!donor) {
    throw new Error(
      `Could not resolve the donor caption chain from CaptionDataClipTrackItem ` +
        `ObjectID=${donorItemId}. The caption track shape is unexpected.`,
    );
  }

  // Read existing items' Start ticks now (from the original xml) so step 6 can
  // re-sort the full list. Done before any mutation.
  const allItemsForSort: { objectId: number; startTicks: bigint }[] = itemRefs.map((id) => ({
    objectId: id,
    startTicks: readItemStartTicks(xml, id),
  }));

  // ── 5. Allocate IDs and build N caption objects ────────────────────────────
  const firstNewId = maxObjectId(xml) + 1;
  let nextId = firstNewId;

  const clonedBlocks: string[] = [];

  for (const caption of captions) {
    const startTicks = BigInt(Math.round(caption.startSec * Number(TICKS_PER_SECOND)));
    const endTicks = BigInt(Math.round(caption.endSec * Number(TICKS_PER_SECOND)));
    if (endTicks <= startTicks) {
      throw new Error(
        `caption endSec (${caption.endSec}) must be greater than startSec (${caption.startSec})`,
      );
    }

    const newItemId = nextId++;
    const newCompId = nextId++;
    const newSubId = nextId++;
    const newBlockId = nextId++;
    const newClipId = nextId++;
    allItemsForSort.push({ objectId: newItemId, startTicks });

    const idMap = new Map<number, number>([
      [donor.trackItemId, newItemId],
      [donor.componentChainId, newCompId],
      [donor.subClipId, newSubId],
      [donor.blockId, newBlockId],
      [donor.transcriptClipId, newClipId],
    ]);

    const cloneOf = (tag: string, id: number): string => {
      const block = extractElement(xml, tag, id);
      if (!block) throw new Error(`donor block missing: ${tag} ObjectID=${id}`);
      return remapBlock(block, idMap);
    };

    // CaptionDataClipTrackItem — remap refs, set timeline Start/End.
    let item = cloneOf("CaptionDataClipTrackItem", donor.trackItemId);
    item = setCaptionPosition(item, startTicks, endTicks);

    // DataComponentChain — empty stub, clone as-is (just the new ObjectID).
    const comp = cloneOf("DataComponentChain", donor.componentChainId);

    // SubClip "SyntheticCaption" — keeps the SHARED MasterClip ObjectURef; only
    // its own ObjectID and the Clip ObjectRef (→ new TranscriptClip) are remapped.
    const sub = cloneOf("SubClip", donor.subClipId);

    // TranscriptClip — keeps the SHARED Source ObjectRef; fresh ClipID so N
    // clones don't share one GUID (mirrors cut's per-clone ClipID regen).
    let clip = cloneOf("TranscriptClip", donor.transcriptClipId);
    clip = clip.replace(/<ClipID>[^<]+<\/ClipID>/, `<ClipID>${newGuid()}</ClipID>`);

    // Block — rewrite the FormattedTextData base64 to the caption text.
    let block = cloneOf("Block", donor.blockId);
    block = rewriteBlockText(block, caption.text);

    clonedBlocks.push(item, comp, sub, block, clip);
  }

  // ── 6. Rebuild the caption track's ref list, sorted by Start ticks ──────────
  // (existing + new items, Index renumbered 0..M-1 — matches Premiere's native
  // ticks-ascending invariant, so a mid-timeline injection is never out of order)
  const updatedTrackBlock = rebuildTrackItemsSorted(trackBlock, allItemsForSort);
  xml = xml.replace(trackBlock, updatedTrackBlock);

  // ── 7. Insert cloned objects adjacent to the donor anchor (L099) ───────────
  const anchorBlock = extractElement(xml, "CaptionDataClipTrackItem", donor.trackItemId);
  if (!anchorBlock) {
    throw new Error("could not find donor CaptionDataClipTrackItem for insertion anchor");
  }
  xml = xml.replace(anchorBlock, anchorBlock + "\n" + clonedBlocks.join("\n"));

  // ── 8. Self-validate ───────────────────────────────────────────────────────
  const validation = selfValidateCaptions(
    xml,
    captionTrackUid,
    priorItemCount,
    captions.length,
    firstNewId,
  );

  // ── 9. Write output ────────────────────────────────────────────────────────
  const backupPath = prprojPath + ".bak";
  fs.copyFileSync(prprojPath, backupPath);
  gzipWriteSync(prprojPath, xml);

  let debugPath: string | undefined;
  if (debug) {
    debugPath = prprojPath + ".captions-inject-debug.json";
    fs.writeFileSync(
      debugPath,
      JSON.stringify(
        {
          targetSequenceName,
          targetSeqUid: seqFound.uid,
          captionTrackUid,
          priorItemCount,
          captionsInjected: captions.length,
          objectsCreated: nextId - firstNewId,
          donor,
          validation,
        },
        null,
        2,
      ),
    );
  }

  return {
    outputPath: prprojPath,
    backupPath,
    debugPath,
    captionsInjected: captions.length,
    objectsCreated: nextId - firstNewId,
    captionTrackUid,
    validation,
  };
}

/**
 * Read a caption item's timeline Start ticks. The very first item on a track
 * omits <Start> entirely (implicit 0); every later item carries it. Used as the
 * sort key when rebuilding the TrackItem list.
 */
function readItemStartTicks(xml: string, itemId: number): bigint {
  const block = extractElement(xml, "CaptionDataClipTrackItem", itemId);
  if (!block) return 0n;
  const m = /<Start>(\d+)<\/Start>/.exec(block);
  return m ? BigInt(m[1]) : 0n; // first item omits <Start> ⇒ starts at 0
}

/**
 * Rebuild the caption track's <TrackItem> ref list so every item — existing and
 * newly injected — is ordered by its timeline Start ticks, with Index renumbered
 * 0..M-1. Premiere natively keeps caption items ticks-ascending + Index-contiguous
 * (verified: 1150-item I35 track is fully sorted). Matching that invariant means an
 * injected mid-timeline caption renders at its real time whether Premiere sorts on
 * read or trusts Index order — out-of-order is eliminated by construction, not by
 * betting on Premiere's tolerance (advisor 2026-06-13, L111). Step 7 (object block
 * placement next to the donor anchor) is unaffected: the ref list order, not the
 * object body order, determines timeline position.
 */
function rebuildTrackItemsSorted(
  trackBlock: string,
  items: { objectId: number; startTicks: bigint }[],
): string {
  const ordered = [...items].sort((a, b) =>
    a.startTicks < b.startTicks ? -1 : a.startTicks > b.startTicks ? 1 : 0,
  );
  const lines = ordered
    .map((it, i) => `\t\t\t\t\t<TrackItem Index="${i}" ObjectRef="${it.objectId}"/>`)
    .join("\n");
  // Replace the entire <TrackItem .../> run between <TrackItems ...> and </TrackItems>.
  const re = /(<TrackItems\b[^>]*>)[\s\S]*?([ \t]*<\/TrackItems>)/;
  if (!re.test(trackBlock)) {
    throw new Error("caption track has no <TrackItems>…</TrackItems> block to rebuild");
  }
  return trackBlock.replace(re, `$1\n${lines}\n$2`);
}

// ── self-validation ──────────────────────────────────────────────────────────

export function selfValidateCaptions(
  xml: string,
  captionTrackUid: string,
  priorItemCount: number,
  injectedCount: number,
  firstNewId: number,
): CaptionValidationResult {
  const errors: string[] = [];

  // (a) Well-formed (fast heuristic — no DOM parser).
  const wellFormed =
    xml.includes("<PremiereData") &&
    xml.includes("</PremiereData>") &&
    !xml.includes("</PremiereData></PremiereData>");
  if (!wellFormed) errors.push("XML wrapper malformed");

  // (b) All ObjectRefs resolve.
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

  // (c) No duplicate new IDs (IDs at/above firstNewId must be unique).
  const newIdCounts = new Map<number, number>();
  const idRe2 = /ObjectID="(\d+)"/g;
  while ((m = idRe2.exec(xml)) !== null) {
    const id = parseInt(m[1], 10);
    if (id >= firstNewId) newIdCounts.set(id, (newIdCounts.get(id) ?? 0) + 1);
  }
  const dupIds = [...newIdCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  const newIdDuplicates = dupIds.length > 0;
  if (newIdDuplicates) errors.push(`duplicate new ObjectIDs: ${dupIds.slice(0, 10).join(", ")}`);

  // (d) Caption track item count grew by exactly injectedCount.
  const trackBlock = extractElementByUid(xml, "CaptionDataClipTrack", captionTrackUid) ?? "";
  const captionTrackItemCount = (trackBlock.match(/<TrackItem Index="\d+" ObjectRef="\d+"/g) ?? [])
    .length;
  const expected = priorItemCount + injectedCount;
  if (captionTrackItemCount !== expected) {
    errors.push(
      `caption track has ${captionTrackItemCount} items, expected ${expected} ` +
        `(${priorItemCount} prior + ${injectedCount} injected)`,
    );
  }

  return {
    wellFormed,
    allRefsResolved,
    newIdDuplicates,
    captionTrackItemCount,
    expectedCaptionCount: expected,
    priorItemCount,
    passed:
      wellFormed &&
      allRefsResolved &&
      !newIdDuplicates &&
      captionTrackItemCount === expected &&
      errors.length === 0,
    errors,
  };
}
