// Action registry. Each domain module exports { "domain.action": handler }.
const captions = require("./captions.js");
const project = require("./project.js");
const sequence = require("./sequence.js");

module.exports = Object.assign({}, captions, project, sequence);
