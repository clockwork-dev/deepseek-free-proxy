const { handleHealth } = require('./health');
const { handleModels } = require('./models');
const { handleSessions } = require('./sessions');
const { handleChat } = require('./chat');

function dispatchRoute(req, res, url, state = {}) {
    if (handleHealth(req, res, url, state)) return true;
    if (handleModels(req, res, url, state)) return true;
    if (handleSessions(req, res, url, state)) return true;
    if (handleChat(req, res, url, state)) return true;

    res.writeHead(404);
    res.end('Not found');
    return false;
}

module.exports = {
    dispatchRoute,
    handleHealth,
    handleModels,
    handleSessions,
    handleChat,
};
