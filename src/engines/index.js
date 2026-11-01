// The building blocks behind the path dashboards, in one require:
//   const { registry, pipeline, metrics, checklists } = require('../engines');
module.exports = {
  registry: require('./registry'),
  pipeline: require('./pipeline'),
  metrics: require('./metrics'),
  checklists: require('./checklists'),
  format: require('./format'),
  dates: require('./dates'),
  errors: require('./errors')
};
