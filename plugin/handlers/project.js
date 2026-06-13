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

async function projectImport({ paths }) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("paths[] required");
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("no project open in Premiere");
  const ok = await project.importFiles(paths);
  return { imported: ok !== false, paths };
}

async function projectClose({ saveFirst = false } = {}) {
  const project = await ppro.Project.getActiveProject();
  if (!project) return { closed: false, reason: "no project open" };
  const projectPath = project.path;
  const projectName = project.name;
  if (saveFirst) {
    await project.save();
  }
  // CloseProjectOptions: promptIfDirty=false so we don't get a dialog
  const opts = new ppro.CloseProjectOptions();
  opts.setPromptIfDirty(false);
  opts.setSaveWorkspace(false);
  // close() is an instance method; older builds exposed it on Project
  const ok = typeof project.close === "function"
    ? await project.close(opts)
    : await ppro.Project.close(opts);
  return { closed: ok !== false, path: projectPath, name: projectName };
}

async function projectOpen({ path: filePath }) {
  if (!filePath) throw new Error("path is required");
  const opts = new ppro.OpenProjectOptions();
  opts.setShowLocateFileDialog(false);
  opts.setShowConvertProjectDialog(false);
  opts.setShowWarningDialog(false);
  const project = await ppro.Project.open(filePath, opts);
  if (!project) throw new Error(`failed to open project: ${filePath}`);
  return { opened: true, name: project.name, path: project.path };
}

module.exports = {
  "project.info": projectInfo,
  "project.save": projectSave,
  "project.import": projectImport,
  "project.close": projectClose,
  "project.open": projectOpen,
};
