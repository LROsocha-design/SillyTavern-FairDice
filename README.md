# Fair Dice for SillyTavern

Dice an AI game master can't cheat with. Before each roll, the model has to say what's at stake. The dice then decide the result, and swiping or regenerating can't re-roll it.

This is the SillyTavern version of [Fair Dice](https://github.com/LROsocha-design/fair-dice-mcp), with the same three tools, rules and wording:

- **resolve_action**: 2d6 for an uncertain action, with the cost of a partial success and the trouble of a failure declared before the roll. 10+ is success, 7–9 is success at the declared cost, 6 or less is failure with the declared trouble.
- **ask_oracle**: a d100 yes/no answer about the world, rolled against a likelihood the model sets first.
- **roll_dice**: dice notation for damage, tables and counts (`3d6`, `2d8+3`, `4d6kh3`).

## Install

1. In SillyTavern, open Extensions → Install extension and paste `https://github.com/LROsocha-design/SillyTavern-FairDice`.
2. Use a Chat Completion API whose model supports tool calling, and tick "Enable function calling" in AI Response Configuration.
3. Switch dice on for a chat from the wand menu ("Fair Dice"), or type `/dice on`.

## Settings

Find these under Extensions → Fair Dice:

- **Dice on in chats I haven't switched**: the default for new chats. Dice are off by default.
- **Tools the model may use**: switch any of the three off.
- **Remind the model to roll**: a short system note near the end of the chat while dice are on. Two buttons fill it with a ready-made rule set:
  - **Rules: roll when uncertain**: roll only for risky actions and unsettled facts.
  - **Rules: roll every prompt**: one 2d6 roll for every message you send, which decides how well its central attempt turns out. The roll is shown as the first line of the reply.
- **Log rolls**: writes every roll to a `.jsonl` file. This needs the optional server plugin (see below).
- **Rolls in this chat**: the last few results.

Results are remembered in the chat itself. For 20 minutes, and for as long as the chat hasn't moved on, asking again about the same action or question returns the original result.

## Optional: roll log

Copy the `server-plugin` folder to `SillyTavern/plugins/fair-dice`, set `enableServerPlugins: true` in `config.yaml`, and restart SillyTavern. Rolls then go to `plugins/fair-dice/rolls.jsonl`. To log somewhere else, put `{ "log": "/full/path/to/rolls.jsonl" }` in `config.json` in that folder.

## License

MIT
