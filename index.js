// Fair Dice for SillyTavern
//   The Fair Dice MCP server (https://github.com/LROsocha-design/fair-dice-mcp) as SillyTavern
//   function tools: resolve_action, ask_oracle and roll_dice, with the same rules and the same
//   result text. The model declares the stakes before the roll, this extension rolls with
//   crypto.getRandomValues and decides the outcome band itself, and asking again for the same
//   action or question returns the original result instead of a new roll.
//
//   Repeats are remembered per chat (in the chat's metadata), so swiping or regenerating can't
//   re-roll: a result stands for 20 minutes, and for as long as the chat hasn't moved past it.
//
//   Dice are switched on per chat from the wand menu (or /dice on|off); the settings drawer sets
//   the default for chats nobody has switched yet. Needs a Chat Completion API with function
//   calling on (AI Response Configuration). Logging rolls to a file is optional and needs the
//   server plugin in server-plugin/ (see the README).

const MODULE = 'fair_dice';
const API = '/api/plugins/fair-dice';
const REPEAT_WINDOW_MS = 20 * 60 * 1000;
const TOOL_NAMES = ['resolve_action', 'ask_oracle', 'roll_dice'];
const REMINDER_DEFAULT = '[Dice are on: before narrating an action whose outcome is genuinely uncertain, call resolve_action with its stakes declared; for a yes/no fact about the world that is not settled yet, call ask_oracle. Roll first, then write the result exactly as returned. Never re-roll, and don\'t roll for things that should simply succeed or simply fail.]';
// Same text as prompts/dice-every-prompt.md in the MCP server repo.
const REMINDER_EVERY_PROMPT = `Every prompt the user sends gets one dice roll, and the roll decides how well the thing the prompt sets in motion turns out: roleplay posts, long-form writing instructions, and any other request alike.

1. Find the central attempt. In an RP post it's what the user's character tries to do. In a writing prompt it's what the scene's main actor is going for. In any other request it's the request itself. One roll per prompt, for that attempt.
2. Roll before writing. Call resolve_action at the start of the reply, with the attempt, the cost if it half-works (yes_but), and what goes wrong if it fails (no_and). Use a modifier (-2 to +2) only from established facts, with the reason.
3. Show the roll as the first line of the reply, e.g. "Roll: 9 (yes-but)", then write.
4. Write the result as rolled:
- 10 or more: the attempt succeeds as intended.
- 7-9: it succeeds, and the declared cost lands.
- 6 or less: it fails, and the declared trouble happens.
- Degree inside the band: higher totals mean a better version, lower a worse one. Double six is the best case the scene allows; double one is the worst.
5. Never re-roll, and never write a different result than the one rolled.

If other instructions also call for rolls, this roll already covers the prompt's central attempt; don't roll it twice.

Without a dice tool, don't invent a number. Write one line, "Roll: no dice tool available", and decide the outcome from the facts, or use a 2d6 the user pastes.`;
const DEFAULTS = {
    defaultOn: false,
    tools: { resolve_action: true, ask_oracle: true, roll_dice: true },
    reminder: true,
    reminderText: REMINDER_DEFAULT,
    log: false,
};

let pluginOk = null; // null = not checked yet

const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    const s = { ...DEFAULTS, ...(all[MODULE] || {}) };
    s.tools = { ...DEFAULTS.tools, ...(s.tools || {}) };
    all[MODULE] = s;
    return s;
}

function saveSetting(key, value) {
    settings()[key] = value;
    ctx().saveSettingsDebounced();
    refresh();
}

// ---- per-chat state: { on?: boolean, action: { key: { at, len, text } }, oracle: { ... } } ----

function chatOpen() {
    return !!ctx().chatId;
}

function chatState() {
    const meta = ctx().chatMetadata;
    meta[MODULE] ??= {};
    meta[MODULE].action ??= {};
    meta[MODULE].oracle ??= {};
    return meta[MODULE];
}

function diceOn() {
    if (!chatOpen()) return false;
    const on = ctx().chatMetadata?.[MODULE]?.on;
    return typeof on === 'boolean' ? on : settings().defaultOn;
}

function setDiceOn(on) {
    if (!chatOpen()) {
        toastr.warning('Open a chat first.', 'Fair Dice');
        return;
    }
    chatState().on = on;
    ctx().saveMetadataDebounced();
    refresh();
    toastr.info(on ? 'Dice are on for this chat.' : 'Dice are off for this chat.', 'Fair Dice');
}

// ---- dice ----

function die(sides) {
    // Rejection sampling, so every face is equally likely.
    const limit = Math.floor(0x100000000 / sides) * sides;
    const buf = new Uint32Array(1);
    do crypto.getRandomValues(buf); while (buf[0] >= limit);
    return (buf[0] % sides) + 1;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clock = (t) => new Date(t).toTimeString().slice(0, 5);
const str = (v) => (typeof v === 'string' ? v : '');

function repeatOf(kind, key) {
    const r = chatState()[kind][key];
    if (!r) return null;
    const fresh = Date.now() - r.at < REPEAT_WINDOW_MS;
    const notPast = ctx().chat.length <= r.len + 2; // a swipe or regenerate of the same turn
    return fresh || notPast ? r : null;
}

function remember(kind, key, text) {
    const bucket = chatState()[kind];
    bucket[key] = { at: Date.now(), len: ctx().chat.length, text };
    const keys = Object.keys(bucket);
    if (keys.length > 200) {
        keys.sort((a, b) => bucket[a].at - bucket[b].at).slice(0, keys.length - 200).forEach(k => delete bucket[k]);
    }
    ctx().saveMetadataDebounced();
}

function log(rec) {
    if (!settings().log || pluginOk === false) return;
    const c = ctx();
    fetch(API + '/log', {
        method: 'POST',
        headers: c.getRequestHeaders(),
        body: JSON.stringify({ chat: c.chatId, character: c.name2, ...rec }),
    }).then(r => {
        if (r.status === 404) pluginOk = false;
    }).catch(() => { /* logging must never break a roll */ });
}

const refused = (why) => `REFUSED: ${why}`;

function badText(value, min, max) {
    return typeof value !== 'string' || value.trim().length < min || value.length > max;
}

// ---- the three tools (same rules and wording as dice-server.cjs) ----

function resolveAction({ action, yes_but, no_and, modifier = 0, modifier_reason } = {}) {
    if (badText(action, 3, 400) || badText(yes_but, 3, 400) || badText(no_and, 3, 400)) {
        return refused('action, yes_but and no_and are all required, 3 to 400 characters each.');
    }
    modifier = Number(modifier ?? 0);
    if (!Number.isInteger(modifier) || modifier < -2 || modifier > 2) {
        return refused('modifier must be a whole number from -2 to +2.');
    }
    if (modifier !== 0 && !str(modifier_reason).trim()) {
        return refused('a non-zero modifier needs modifier_reason (the established fact behind it). Call again with a reason or with modifier 0.');
    }
    const key = norm(action);
    const prev = repeatOf('action', key);
    if (prev) {
        log({ tool: 'resolve_action', repeat: true, action });
        return `ALREADY RESOLVED at ${clock(prev.at)}. That result stands and cannot be re-rolled:\n${prev.text}`;
    }
    const dice = [die(6), die(6)];
    const total = dice[0] + dice[1] + modifier;
    const mod = modifier ? ` ${modifier > 0 ? '+' : '-'} ${Math.abs(modifier)} (${modifier_reason.trim()})` : '';
    let out;
    if (total >= 10) out = `YES: ${action} succeeds cleanly.`;
    else if (total >= 7) out = `YES-BUT: ${action} succeeds, and this cost lands: ${yes_but}`;
    else out = `NO-AND: ${action} fails, and this happens: ${no_and}`;
    const result = `2d6 [${dice.join(', ')}]${mod} = ${total} -> ${out}`;
    remember('action', key, result);
    log({ tool: 'resolve_action', action, yes_but, no_and, modifier, modifier_reason, dice, total, outcome: out.split(':')[0] });
    return result;
}

const LIKELIHOOD = {
    'nearly impossible': 5,
    'very unlikely': 15,
    unlikely: 30,
    even: 50,
    likely: 70,
    'very likely': 85,
    'nearly certain': 95,
};

function askOracle({ question, likelihood, reason } = {}) {
    if (badText(question, 3, 400)) return refused('question is required, 3 to 400 characters.');
    if (!Object.hasOwn(LIKELIHOOD, likelihood)) {
        return refused(`likelihood must be one of: ${Object.keys(LIKELIHOOD).join(', ')}.`);
    }
    const key = norm(question);
    const prev = repeatOf('oracle', key);
    if (prev) {
        log({ tool: 'ask_oracle', repeat: true, question });
        return `ALREADY ANSWERED at ${clock(prev.at)}. That answer stands:\n${prev.text}`;
    }
    const chance = LIKELIHOOD[likelihood];
    const roll = die(100);
    const yesAnd = Math.max(1, Math.ceil(chance / 5));
    const noAnd = 100 - Math.max(1, Math.ceil((100 - chance) / 5));
    let answer;
    if (roll <= yesAnd) answer = 'YES, AND (yes, with an extra twist in the same direction)';
    else if (roll <= chance) answer = 'YES';
    else if (roll > noAnd) answer = 'NO, AND (no, with an extra twist in the same direction)';
    else answer = 'NO';
    const result = `d100 = ${roll} vs ${chance}% (${likelihood}) -> ${answer}. Question: ${question}`;
    remember('oracle', key, result);
    log({ tool: 'ask_oracle', question, likelihood, reason, chance, roll, answer: answer.split(' (')[0] });
    return result;
}

function rollDice({ notation, purpose } = {}) {
    if (badText(notation, 2, 30)) return refused('notation must look like d100, 3d6, 2d8+3, 2d20kh1 or 4d6kh3.');
    if (badText(purpose, 3, 300)) return refused('purpose is required: what this roll decides, stated before rolling.');
    const m = notation.replace(/\s+/g, '').toLowerCase().match(/^(\d*)d(\d+)(?:(kh|kl)(\d+))?([+-]\d+)?$/);
    if (!m) return refused('notation must look like d100, 3d6, 2d8+3, 2d20kh1 or 4d6kh3.');
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const sides = parseInt(m[2], 10);
    const keepMode = m[3];
    const keep = m[4] ? parseInt(m[4], 10) : n;
    const add = m[5] ? parseInt(m[5], 10) : 0;
    if (n < 1 || n > 50 || sides < 2 || sides > 1000 || keep < 1 || keep > n || Math.abs(add) > 1000) {
        return refused('limits are 1-50 dice, 2-1000 sides, keep 1..N, modifier within +/-1000.');
    }
    const rolls = Array.from({ length: n }, () => die(sides));
    let kept = rolls;
    if (keepMode) kept = [...rolls].sort((a, b) => (keepMode === 'kh' ? b - a : a - b)).slice(0, keep);
    const total = kept.reduce((a, b) => a + b, 0) + add;
    const result = `${notation} for "${purpose}": rolled [${rolls.join(', ')}]${keepMode ? ` kept [${kept.join(', ')}]` : ''}${add ? ` ${add > 0 ? '+' : '-'} ${Math.abs(add)}` : ''} = ${total}`;
    log({ tool: 'roll_dice', notation, purpose, rolls, kept, add, total });
    return result;
}

const TOOLS = [
    {
        name: 'resolve_action',
        displayName: 'Resolve action (2d6)',
        description:
            'Roll 2d6 + modifier to decide an uncertain action by a character, BEFORE narrating it. ' +
            'Declare everything first: the action, what the cost is if it partly succeeds (yes_but), what goes wrong if it fails (no_and), ' +
            'and a modifier from -2 to +2 only when established facts justify it (state the reason). ' +
            'Result bands: 10+ yes (clean success), 7-9 yes-but (success with the declared cost), 6 or less no-and (failure plus the declared consequence). ' +
            'One call per uncertain action. Never re-roll; the result is final and must be narrated as returned. Do not roll for actions that should simply succeed or simply fail.',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', minLength: 3, maxLength: 400, description: 'Who attempts what, in one sentence.' },
                yes_but: { type: 'string', minLength: 3, maxLength: 400, description: 'The cost or complication if the result is 7-9.' },
                no_and: { type: 'string', minLength: 3, maxLength: 400, description: 'What goes wrong if the result is 6 or less.' },
                modifier: { type: 'integer', minimum: -2, maximum: 2, default: 0, description: '-2..+2, only from established facts (skill, gear, position, odds).' },
                modifier_reason: { type: 'string', maxLength: 300, description: 'Required when modifier is not 0.' },
            },
            required: ['action', 'yes_but', 'no_and'],
        },
        action: resolveAction,
        formatMessage: (p) => `🎲 2d6: ${str(p?.action)}`,
    },
    {
        name: 'ask_oracle',
        displayName: 'Ask the oracle (d100)',
        description:
            'Answer a yes/no question about the world that the established facts do not settle (is the gate guarded? is the merchant honest? does the storm break tonight?). ' +
            'Declare the likelihood from the facts BEFORE rolling: nearly impossible 5%, very unlikely 15%, unlikely 30%, even 50%, likely 70%, very likely 85%, nearly certain 95%. ' +
            'Rolls d100: at or under the chance is yes, over is no; the extreme fifth of each side upgrades to "yes, and" or "no, and" (an extra twist in the same direction). ' +
            'One call per question; never re-ask the same question; narrate the answer as returned. Do not ask what canon or earlier scenes already answer.',
        parameters: {
            type: 'object',
            properties: {
                question: { type: 'string', minLength: 3, maxLength: 400, description: 'A yes/no question about the world.' },
                likelihood: { type: 'string', enum: Object.keys(LIKELIHOOD), description: 'How likely "yes" is, judged from established facts.' },
                reason: { type: 'string', maxLength: 300, description: 'The facts behind the likelihood.' },
            },
            required: ['question', 'likelihood'],
        },
        action: askOracle,
        formatMessage: (p) => `🔮 Oracle: ${str(p?.question)}`,
    },
    {
        name: 'roll_dice',
        displayName: 'Roll dice',
        description:
            'Roll dice for things that are not action outcomes or yes/no questions: damage, random tables, how many arrive, a random NPC reaction. ' +
            'Declare the purpose first. Notation: NdM, NdM+K, NdM-K, dM, with optional keep-highest/lowest (2d20kh1, 4d6kh3, 2d20kl1). Never re-roll.',
        parameters: {
            type: 'object',
            properties: {
                notation: { type: 'string', minLength: 2, maxLength: 30, description: 'e.g. d100, 3d6, 2d8+3, 2d20kh1, 4d6kh3' },
                purpose: { type: 'string', minLength: 3, maxLength: 300, description: 'What this roll decides, stated before rolling.' },
            },
            required: ['notation', 'purpose'],
        },
        action: rollDice,
        formatMessage: (p) => `🎲 ${str(p?.notation)}: ${str(p?.purpose)}`,
    },
];

function registerTools() {
    for (const tool of TOOLS) {
        ctx().registerFunctionTool({
            ...tool,
            shouldRegister: () => diceOn() && settings().tools[tool.name] !== false,
        });
    }
}

// ---- UI ----

const SETTINGS_HTML = `
<div class="fair-dice-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Fair Dice</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="fd-status" id="fd_status"></div>
            <div id="fd_toggle_chat" class="menu_button"></div>
            <label class="checkbox_label"><input id="fd_default_on" type="checkbox"><span>Dice on in chats I haven't switched (default)</span></label>
            <div class="fd-label">Tools the model may use</div>
            <label class="checkbox_label"><input id="fd_tool_resolve_action" type="checkbox"><span>resolve_action: 2d6 with declared stakes</span></label>
            <label class="checkbox_label"><input id="fd_tool_ask_oracle" type="checkbox"><span>ask_oracle: d100 yes/no about the world</span></label>
            <label class="checkbox_label"><input id="fd_tool_roll_dice" type="checkbox"><span>roll_dice: notation (damage, tables)</span></label>
            <label class="checkbox_label"><input id="fd_reminder" type="checkbox"><span>Remind the model to roll (a short system note near the end of the chat)</span></label>
            <div class="fd-presets">
                <div id="fd_preset_gm" class="menu_button" title="Roll only when an outcome is uncertain">Rules: roll when uncertain</div>
                <div id="fd_preset_every" class="menu_button" title="One roll for every prompt you send">Rules: roll every prompt</div>
            </div>
            <textarea id="fd_reminder_text" class="text_pole textarea_compact" rows="4"></textarea>
            <label class="checkbox_label"><input id="fd_log" type="checkbox"><span>Log rolls to rolls.jsonl (needs the server plugin)</span></label>
            <div class="fd-label">Rolls in this chat</div>
            <div class="fd-rolls" id="fd_rolls"></div>
        </div>
    </div>
</div>`;

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function statusText() {
    const c = ctx();
    const notes = [];
    if (!c.isToolCallingSupported()) {
        notes.push('⚠ Tool calling is off or unsupported: use a Chat Completion API and tick "Enable function calling" in AI Response Configuration.');
    }
    if (!chatOpen()) notes.push('No chat open.');
    else notes.push(diceOn() ? '🎲 Dice are <b>on</b> for this chat.' : 'Dice are <b>off</b> for this chat.');
    if (settings().log) {
        notes.push(pluginOk === false ? '⚠ Log plugin not loaded (restart SillyTavern with server plugins on); rolls are not being logged.'
            : pluginOk ? 'Logging to rolls.jsonl.' : '');
    }
    return notes.filter(Boolean).join('<br>');
}

function rollsHtml() {
    if (!chatOpen()) return '';
    const st = ctx().chatMetadata?.[MODULE];
    const all = [...Object.values(st?.action || {}), ...Object.values(st?.oracle || {})].sort((a, b) => b.at - a.at).slice(0, 8);
    if (!all.length) return '<i>None yet.</i>';
    return all.map(r => `<div class="fd-roll"><span class="fd-time">${clock(r.at)}</span> ${escapeHtml(r.text)}</div>`).join('');
}

function refresh() {
    const on = diceOn();
    const s = settings();
    const c = ctx();
    const reminder = on && s.reminder && s.reminderText.trim();
    // IN_CHAT (1) at depth 1, system role (0)
    c.setExtensionPrompt(MODULE, reminder ? s.reminderText.trim() : '', 1, 1, false, 0);

    $('#fd_status').html(statusText());
    $('#fd_toggle_chat').html(on ? '<i class="fa-solid fa-dice"></i>&nbsp;Turn dice off for this chat' : '<i class="fa-solid fa-dice"></i>&nbsp;Turn dice on for this chat');
    $('#fd_rolls').html(rollsHtml());
    $('#fd_wand_label').text(on ? 'Fair Dice: on' : 'Fair Dice: off');
    $('#fd_wand_button').toggleClass('fd-on', on);
}

function bindSettings() {
    const s = settings();
    $('#fd_default_on').prop('checked', s.defaultOn).on('change', function () { saveSetting('defaultOn', this.checked); });
    for (const name of TOOL_NAMES) {
        $(`#fd_tool_${name}`).prop('checked', s.tools[name] !== false).on('change', function () {
            saveSetting('tools', { ...settings().tools, [name]: this.checked });
        });
    }
    $('#fd_reminder').prop('checked', s.reminder).on('change', function () { saveSetting('reminder', this.checked); });
    $('#fd_reminder_text').val(s.reminderText).on('change', function () {
        saveSetting('reminderText', String($(this).val()).trim() || REMINDER_DEFAULT);
        $(this).val(settings().reminderText);
    });
    const usePreset = (text) => {
        saveSetting('reminderText', text);
        saveSetting('reminder', true);
        $('#fd_reminder_text').val(text);
        $('#fd_reminder').prop('checked', true);
    };
    $('#fd_preset_gm').on('click', () => usePreset(REMINDER_DEFAULT));
    $('#fd_preset_every').on('click', () => usePreset(REMINDER_EVERY_PROMPT));
    $('#fd_log').prop('checked', s.log).on('change', function () { saveSetting('log', this.checked); });
    $('#fd_toggle_chat').on('click', () => setDiceOn(!diceOn()));
}

function addWandButton() {
    if (document.getElementById('fd_wand_button')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = 'fd_wand_button';
    item.classList.add('list-group-item', 'flex-container', 'flexGap5');
    item.innerHTML = '<div class="fa-solid fa-dice extensionsMenuExtensionButton"></div><span id="fd_wand_label">Fair Dice</span>';
    item.addEventListener('click', () => setDiceOn(!diceOn()));
    menu.appendChild(item);
}

function registerSlashCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser || !SlashCommand) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dice',
        callback: async (_args, value) => {
            const v = String(value || '').trim().toLowerCase();
            if (v === 'on' || v === 'off') setDiceOn(v === 'on');
            else if (v === '' || v === 'toggle') setDiceOn(!diceOn());
            else toastr.warning('Use /dice on, /dice off or /dice.', 'Fair Dice');
            return diceOn() ? 'on' : 'off';
        },
        unnamedArgumentList: SlashCommandArgument && ARGUMENT_TYPE ? [
            SlashCommandArgument.fromProps({ description: 'on, off or toggle', typeList: [ARGUMENT_TYPE.STRING], isRequired: false, enumList: ['on', 'off', 'toggle'] }),
        ] : [],
        helpString: 'Fair Dice: switch the dice tools on or off for this chat. With no argument it toggles.',
    }));
}

async function checkPlugin() {
    try {
        const r = await fetch(API + '/status', { headers: ctx().getRequestHeaders() });
        pluginOk = r.ok;
    } catch {
        pluginOk = false;
    }
    refresh();
}

jQuery(() => {
    $('#extensions_settings2').append(SETTINGS_HTML);
    bindSettings();
    addWandButton();
    registerSlashCommand();
    registerTools();
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, refresh);
    eventSource.on(eventTypes.TOOL_CALLS_RENDERED, refresh);
    eventSource.on(eventTypes.CHATCOMPLETION_SOURCE_CHANGED, refresh);
    eventSource.on(eventTypes.SETTINGS_UPDATED, refresh);
    refresh();
    checkPlugin();
});

// For testing from the console: SillyTavern.fairDice.resolveAction({...}) etc.
SillyTavern.fairDice = { resolveAction, askOracle, rollDice, die, diceOn, setDiceOn };
