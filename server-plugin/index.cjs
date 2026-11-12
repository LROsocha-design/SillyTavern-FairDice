'use strict';
// Fair Dice: optional SillyTavern server plugin that keeps a log of every roll.
//
// The extension rolls in the browser; this only appends each roll to a .jsonl file, tagged
// source: "sillytavern". Point it at the same file as the MCP server's FAIR_DICE_LOG to keep
// one log for both.
//
// Install: copy this folder to SillyTavern/plugins/fair-dice, set `enableServerPlugins: true` in
// config.yaml, restart SillyTavern, then tick "Log rolls" in the extension's settings.
// The log goes to rolls.jsonl next to this file; to log somewhere else, put
// { "log": "/full/path/to/rolls.jsonl" } in config.json next to this file.
//
// Routes (all under /api/plugins/fair-dice):
//   GET  /status  { ok, log }
//   POST /log     one roll record from the extension

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG = path.join(__dirname, 'rolls.jsonl');

function logPath() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).log || DEFAULT_LOG;
    } catch {
        return DEFAULT_LOG;
    }
}

async function init(router) {
    router.get('/status', (_req, res) => res.json({ ok: true, log: logPath() }));
    router.post('/log', (req, res) => {
        const rec = req.body;
        if (!rec || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.tool !== 'string') {
            return res.status(400).json({ error: 'expected one roll record with a tool name' });
        }
        delete rec.at;
        delete rec.source;
        try {
            fs.appendFileSync(logPath(), JSON.stringify({ at: new Date().toISOString(), source: 'sillytavern', ...rec }) + '\n');
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

module.exports = {
    init,
    info: {
        id: 'fair-dice',
        name: 'Fair Dice log',
        description: 'Appends Fair Dice rolls to a rolls.jsonl log.',
    },
};
