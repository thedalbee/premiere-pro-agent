const ppro = require("premierepro");

async function projectInfo() {
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    return { open: false };
  }

  let sequenceCount = 0;
  try {
    const sequences = await project.getSequences();
    sequenceCount = Array.isArray(sequences) ? sequences.length : 0;
  } catch {
    // a project with no sequences can throw here; count stays 0
  }

  let activeSequence = null;
  try {
    const active = await project.getActiveSequence();
    if (active) {
      activeSequence = { name: active.name };
    }
  } catch {
    // no active sequence is a normal state
  }

  return {
    open: true,
    name: project.name,
    path: project.path,
    sequenceCount,
    activeSequence,
  };
}

async function projectSave() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("no project open in Premiere");
  await project.save();
  return { saved: true, path: project.path };
}

module.exports = {
  "project.info": projectInfo,
  "project.save": projectSave,
};
