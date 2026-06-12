const ppro = require("premierepro");

async function getActiveProjectOrThrow() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("no project open in Premiere");
  return project;
}

async function findItemByName(parentItem, name) {
  const items = await parentItem.getItems();
  for (const item of items || []) {
    if (item.name === name) return item;
    if (typeof item.getItems === "function") {
      try {
        const found = await findItemByName(item, name);
        if (found) return found;
      } catch {
        // not a bin
      }
    }
  }
  return null;
}

async function findSequenceByName(project, name) {
  const sequences = await project.getSequences();
  for (const seq of sequences || []) {
    if (seq.name === name) return seq;
  }
  return null;
}

// Count items on every caption track plus V1/A1, so each placement attempt
// can be verified against reality instead of trusting action "success".
async function snapshotTracks(seq) {
  const snapshot = { captionTracks: [], v1: 0, a1: 0 };
  try {
    const captionCount = await seq.getCaptionTrackCount();
    for (let i = 0; i < captionCount; i++) {
      const track = await seq.getCaptionTrack(i);
      let count = 0;
      try {
        count = ((await track.getTrackItems(1, false)) || []).length;
      } catch {
        try {
          count = ((await track.getTrackItems(1)) || []).length;
        } catch {
          count = -1; // unreadable
        }
      }
      snapshot.captionTracks.push(count);
    }
  } catch {
    snapshot.captionTracks = null;
  }
  try {
    const v = await seq.getVideoTrack(0);
    snapshot.v1 = ((await v.getTrackItems(1, false)) || []).length;
  } catch {
    snapshot.v1 = -1;
  }
  try {
    const a = await seq.getAudioTrack(0);
    snapshot.a1 = ((await a.getTrackItems(1, false)) || []).length;
  } catch {
    snapshot.a1 = -1;
  }
  return snapshot;
}

// Experiment harness: import an SRT, run a matrix of placement attempts,
// and after each one read the tracks back to see where (if anywhere) the
// captions actually landed.
async function captionsProbe(params) {
  const { srtPath, sequenceName } = params;
  if (!srtPath || !sequenceName) throw new Error("srtPath and sequenceName required");

  const project = await getActiveProjectOrThrow();
  const seq = await findSequenceByName(project, sequenceName);
  if (!seq) throw new Error(`sequence "${sequenceName}" not found`);

  const baseName = srtPath.split("/").pop();
  let srtItem = await findItemByName(await project.getRootItem(), baseName);
  let importedNow = false;
  if (!srtItem) {
    await project.importFiles([srtPath]);
    srtItem = await findItemByName(await project.getRootItem(), baseName);
    importedNow = true;
  }
  if (!srtItem) throw new Error(`imported "${baseName}" but cannot find it in the project`);

  const editor = await ppro.SequenceEditor.getEditor(seq);
  const before = await snapshotTracks(seq);

  const startTime = ppro.TickTime.createWithSeconds(0);
  const attempts = [
    { name: "insert(-1,-1,limited=true)", make: () => editor.createInsertProjectItemAction(srtItem, startTime, -1, -1, true) },
    { name: "insert(-1,-1,limited=false)", make: () => editor.createInsertProjectItemAction(srtItem, startTime, -1, -1, false) },
    { name: "overwrite(-1,-1)", make: () => editor.createOverwriteItemAction(srtItem, startTime, -1, -1) },
    { name: "insert(0,-1,true)", make: () => editor.createInsertProjectItemAction(srtItem, startTime, 0, -1, true) },
    { name: "addItems? createAddItemsAction", make: null }, // probed separately below
  ];

  const results = [];
  for (const attempt of attempts) {
    if (!attempt.make) continue;
    let threw = null;
    try {
      project.lockedAccess(() => {
        project.executeTransaction((tx) => {
          tx.addAction(attempt.make());
        });
      });
    } catch (error) {
      threw = String((error && error.message) || error);
    }
    const after = await snapshotTracks(seq);
    const landed =
      JSON.stringify(after.captionTracks) !== JSON.stringify(before.captionTracks) ||
      after.v1 !== before.v1 ||
      after.a1 !== before.a1;
    results.push({ attempt: attempt.name, threw, after, landed });
    if (landed) break; // stop on first real change so we can inspect it
  }

  return {
    importedNow,
    srtItemName: srtItem.name,
    captionTrackCountBefore: before.captionTracks ? before.captionTracks.length : null,
    before,
    results,
  };
}

// List caption-track counts for every sequence in the project.
async function captionsInspect() {
  const project = await getActiveProjectOrThrow();
  const sequences = await project.getSequences();
  const report = [];
  for (const seq of sequences || []) {
    let captionTracks = null;
    try {
      captionTracks = await seq.getCaptionTrackCount();
    } catch {
      captionTracks = -1;
    }
    report.push({ name: seq.name, captionTracks });
  }
  return { sequences: report };
}

module.exports = {
  "captions.probe": captionsProbe,
  "captions.inspect": captionsInspect,
};
