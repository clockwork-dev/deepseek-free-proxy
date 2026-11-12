const {
    SUPPORTED_MODEL_IDS,
    MODEL_CONFIGS,
    ALL_MODEL_CAPABILITIES,
} = require('../deepseek/client');

function handleModels(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            object: 'list',
            data: SUPPORTED_MODEL_IDS.map(id => ({
                id,
                object: 'model',
                created: 1700000000,
                owned_by: 'deepseek-web',
                real_model: MODEL_CONFIGS[id].real_model,
                capabilities: MODEL_CONFIGS[id].capabilities,
            })),
        }));
        return true;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', data: ALL_MODEL_CAPABILITIES }));
        return true;
    }

    return false;
}

module.exports = {
    handleModels,
};
