// Action registry. Each domain module exports { "domain.action": handler }.
const project = require("./project.js");
const sequence = require("./sequence.js");

module.exports = Object.assign({}, project, sequence);
