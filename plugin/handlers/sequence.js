const ppro = require("premierepro");

// ── helpers ─────────────────────────────────────────────────────────

async function getActiveProject() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("no project open in Premiere");
  return project;
}

async function findItemByName(parentItem, name) {
  const items = await parentItem.getItems();
  for (const item of items || []) {
    if (item.name === name) return item;
    // bins report getItems too — recurse into them
    if (typeof item.getItems === "function") {
      try {
        const found = await findItemByName(item, name);
        if (found) return found;
      } catch {
        // not a bin — keep scanning siblings
      }
    }
  }
  return null;
}

async function ensureImported(project, mediaPath) {
  const baseName = mediaPath.split("/").pop();
  const root = await project.getRootItem();
  let item = await findItemByName(root, baseName);
  if (item) return item;

  await project.importFiles([mediaPath]);
  item = await findItemByName(await project.getRootItem(), baseName);
  if (!item) throw new Error(`imported "${baseName}" but could not find it in the project`);
  return item;
}

async function findSequenceByName(project, name) {
  const sequences = await project.getSequences();
  for (const seq of sequences || []) {
    if (seq.name === name) return seq;
  }
  return null;
}

async function getEditor(seq) {
  if (ppro.SequenceEditor && typeof ppro.SequenceEditor.getEditor === "function") {
    const editor = await ppro.SequenceEditor.getEditor(seq);
    if (editor) return editor;
  }
  throw new Error("could not get SequenceEditor");
}

// Remove every clip from the sequence. Selection comes from
// sequence.getSelection() — TrackItemSelection.createEmptySelection() does
// NOT work in this Premiere build (lesson L091). API signatures vary between
// builds, so the remove action uses a verified fallback chain.
async function clearAllClips(project, seq) {
  const items = [];
  const vCount = await seq.getVideoTrackCount();
  for (let i = 0; i < vCount; i++) {
    const track = await seq.getVideoTrack(i);
    const found = await track.getTrackItems(1, false);
    if (found) items.push(...found);
  }
  const aCount = await seq.getAudioTrackCount();
  for (let i = 0; i < aCount; i++) {
    const track = await seq.getAudioTrack(i);
    const found = await track.getTrackItems(1, false);
    if (found) items.push(...found);
  }
  if (items.length === 0) return;

  const selection = await seq.getSelection();
  for (const item of items) {
    try {
      selection.addItem(item, false);
    } catch {
      selection.addItem(item);
    }
  }

  const editor = await getEditor(seq);
  const mediaTypeAny = ppro.Constants && ppro.Constants.MediaType ? ppro.Constants.MediaType.ANY : undefined;
  const removeVariants = [
    () => editor.createRemoveItemsAction(selection, false, mediaTypeAny),
    () => editor.createRemoveItemsAction(selection, false),
    () => editor.createRemoveItemsAction(selection),
  ];
  const removeErrors = [];
  let removed = false;
  for (const makeAction of removeVariants) {
    try {
      project.lockedAccess(() => {
        project.executeTransaction((tx) => {
          tx.addAction(makeAction());
        });
      });
      removed = true;
      break;
    } catch (error) {
      removeErrors.push(String((error && error.message) || error));
    }
  }
  if (!removed) {
    throw new Error(`remove action failed: ${removeErrors.join(" / ")}`);
  }

  // verify the timeline is actually empty — a sequence that silently keeps
  // its full-length source clip would corrupt every placement after it
  const vTrack = await seq.getVideoTrack(0);
  const remaining = await vTrack.getTrackItems(1, false);
  if (remaining && remaining.length > 0) {
    throw new Error(`${remaining.length} clip(s) remain on V1`);
  }
}

// Subclasses (Audio/VideoClipTrackItem) can hide TrackItem methods — cast up.
async function asTrackItem(clip) {
  if (!clip) return null;
  if (typeof clip.createSetOutPointAction === "function") return clip;
  if (typeof clip.queryCast === "function" && ppro.TrackItem) {
    try {
      const cast = await clip.queryCast("TrackItem");
      if (cast) return cast;
    } catch {
      // fall through
    }
  }
  if (ppro.TrackItem && typeof ppro.TrackItem.castOrThrow === "function") {
    try {
      return await ppro.TrackItem.castOrThrow(clip);
    } catch {
      // fall through
    }
  }
  return clip;
}

// ── actions ─────────────────────────────────────────────────────────

// Build a new sequence from a media file, keeping only the given source
// ranges, butted together with zero gaps. clips: [{ start, end }] seconds.
async function sequenceCut(params) {
  const { mediaPath, sequenceName, clips, overwrite } = params;
  if (!mediaPath || !sequenceName || !Array.isArray(clips) || clips.length === 0) {
    throw new Error("mediaPath, sequenceName and a non-empty clips array are required");
  }

  // stage tracking: UXP errors like "Illegal Parameter type" carry no
  // location, so every thrown error gets prefixed with where it happened.
  let stage = "start";
  try {
    return await sequenceCutStaged(params, (s) => {
      stage = s;
    });
  } catch (error) {
    throw new Error(`[${stage}] ${String((error && error.message) || error)}`);
  }
}

async function sequenceCutStaged({ mediaPath, sequenceName, clips, overwrite }, setStage) {
  setStage("getProject");
  const project = await getActiveProject();

  setStage("checkExistingSequence");
  const existing = await findSequenceByName(project, sequenceName);
  if (existing) {
    if (!overwrite) {
      throw new Error(`sequence "${sequenceName}" already exists — pass overwrite to replace it`);
    }
    setStage("deleteExistingSequence");
    const deleted = await project.deleteSequence(existing);
    if (!deleted) throw new Error(`could not delete existing sequence "${sequenceName}"`);
  }

  setStage("importMedia");
  const sourceItem = await ensureImported(project, mediaPath);

  // createSequenceFromMedia inherits the source's fps/frame size (a preset
  // guess from createSequence would not), then we empty the timeline.
  setStage("createSequence");
  const seq = await project.createSequenceFromMedia(sequenceName, [sourceItem]);
  if (!seq) throw new Error("createSequenceFromMedia returned nothing");
  setStage("clearInitialClips");
  await clearAllClips(project, seq);

  setStage("activateSequence");
  try {
    await project.setActiveSequence(seq);
    await project.openSequence(seq);
  } catch {
    // activation is cosmetic — placement works on the handle we hold
  }

  setStage("getEditor");
  const editor = await getEditor(seq);
  const audioTrackCount = await seq.getAudioTrackCount();

  const placements = [];
  let timelinePos = 0;

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const duration = clip.end - clip.start;
    if (duration <= 0) continue;
    setStage(`placeClip ${i + 1}/${clips.length}`);

    // snapshot counts so the freshly placed items can be found by index delta
    const vTrack0 = await seq.getVideoTrack(0);
    const vCountBefore = ((await vTrack0.getTrackItems(1, false)) || []).length;
    const aCountsBefore = [];
    for (let ai = 0; ai < audioTrackCount; ai++) {
      const track = await seq.getAudioTrack(ai);
      aCountsBefore[ai] = ((await track.getTrackItems(1, false)) || []).length;
    }

    const insertTime = ppro.TickTime.createWithSeconds(timelinePos);
    await project.lockedAccess(() => {
      project.executeTransaction((tx) => {
        tx.addAction(editor.createOverwriteItemAction(sourceItem, insertTime, 0, 0));
      });
    });

    // locate the new video item (index delta, position fallback)
    const vItems = (await vTrack0.getTrackItems(1, false)) || [];
    let vClip = null;
    if (vItems.length > vCountBefore) {
      vClip = vItems[vItems.length - 1];
    } else {
      for (const item of vItems) {
        const st = await item.getStartTime();
        if (Math.abs(st.seconds - timelinePos) < 0.2) {
          vClip = item;
          break;
        }
      }
    }

    // the overwrite can spawn audio items on several tracks (lesson L086) —
    // every one of them must be trimmed and moved, not just A1
    const aClips = [];
    for (let ai = 0; ai < audioTrackCount; ai++) {
      const track = await seq.getAudioTrack(ai);
      const items = (await track.getTrackItems(1, false)) || [];
      if (items.length > aCountsBefore[ai]) {
        for (let n = aCountsBefore[ai]; n < items.length; n++) aClips.push(items[n]);
      } else {
        for (const item of items) {
          const st = await item.getStartTime();
          if (Math.abs(st.seconds - timelinePos) < 0.2) {
            aClips.push(item);
            break;
          }
        }
      }
    }
    if (!vClip && aClips.length === 0) {
      throw new Error(`clip ${i}: nothing found on the timeline after overwrite`);
    }

    vClip = await asTrackItem(vClip);
    const audioItems = [];
    for (const a of aClips) {
      const cast = await asTrackItem(a);
      if (cast) audioItems.push(cast);
    }

    // trim right, trim left, then shift back — three separate transactions,
    // the order verified in production (setInPoint moves the item right)
    const outTime = ppro.TickTime.createWithSeconds(clip.end);
    await project.lockedAccess(() => {
      project.executeTransaction((tx) => {
        if (vClip) tx.addAction(vClip.createSetOutPointAction(outTime));
        for (const a of audioItems) tx.addAction(a.createSetOutPointAction(outTime));
      });
    });

    const inTime = ppro.TickTime.createWithSeconds(clip.start);
    await project.lockedAccess(() => {
      project.executeTransaction((tx) => {
        if (vClip) tx.addAction(vClip.createSetInPointAction(inTime));
        for (const a of audioItems) tx.addAction(a.createSetInPointAction(inTime));
      });
    });

    const shiftBack = ppro.TickTime.createWithSeconds(-clip.start);
    await project.lockedAccess(() => {
      project.executeTransaction((tx) => {
        if (vClip) tx.addAction(vClip.createMoveAction(shiftBack));
        for (const a of audioItems) tx.addAction(a.createMoveAction(shiftBack));
      });
    });

    // record the REAL landed position (lesson L062: never reconstruct the
    // source→timeline map by guesswork — read it back from the timeline)
    let landedStart = timelinePos;
    let landedEnd = timelinePos + duration;
    const probe = vClip ?? audioItems[0];
    if (probe) {
      try {
        landedStart = (await probe.getStartTime()).seconds;
        landedEnd = (await probe.getEndTime()).seconds;
      } catch {
        // keep computed values if the probe fails
      }
    }
    placements.push({
      sourceStart: clip.start,
      sourceEnd: clip.end,
      timelineStart: Math.round(landedStart * 10000) / 10000,
      timelineEnd: Math.round(landedEnd * 10000) / 10000,
    });

    timelinePos += duration;
  }

  // final track inventory for the caller's gap audit
  setStage("inventory");
  const trackCounts = { video: [], audio: [] };
  const vCount = await seq.getVideoTrackCount();
  for (let i = 0; i < vCount; i++) {
    const track = await seq.getVideoTrack(i);
    trackCounts.video.push(((await track.getTrackItems(1, false)) || []).length);
  }
  for (let i = 0; i < audioTrackCount; i++) {
    const track = await seq.getAudioTrack(i);
    trackCounts.audio.push(((await track.getTrackItems(1, false)) || []).length);
  }

  let timebaseTicks = null;
  try {
    timebaseTicks = String(await seq.getTimebase());
  } catch {
    // optional diagnostic
  }

  return {
    sequenceName: seq.name,
    placedCount: placements.length,
    requestedCount: clips.length,
    sequenceEndSec: (await seq.getEndTime()).seconds,
    timebaseTicks,
    trackCounts,
    placements,
  };
}

module.exports = {
  "sequence.cut": sequenceCut,
};
