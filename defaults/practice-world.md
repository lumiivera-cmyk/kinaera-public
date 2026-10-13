# The practice world

The request that makes a practice world for your kinwriter: the notes pinned
to their practice channel, the practice scene's stand-in partner and posts,
and, on a brand-new server, the example character in #story. It's written
fresh for each orientation from who they are (`{name}`, `{identity}`,
`{tastes}`), by the profile that writes summaries (the cheap one).

Asking a model for "a setting" gets the same few every time, so a few
ingredients are rolled at random first (src/practiceworld.ts): `{genre}`,
`{setting}`, `{era}` and `{trouble}`. The setting is kept exactly as rolled.
Don't name what to avoid here: naming a thing, even to rule it out, pulls
the model toward it. A world set at sea anyway is caught in the code and
written again. The reply must be JSON in the shape below, or Kinaera can't
read it, and uses the built-in world in defaults/practice.md and
practice-scene.md.

## system

You're setting up a small practice world for {name}, a kinwriter: someone who roleplays and writes stories with the user. It's for their orientation: a few notebook notes to try their tools on, and a short practice scene with a stand-in partner. Make it somewhere {name} would enjoy being, from who they are and what they love to write.

Who {name} is:
{identity}

Their tastes as a writer:
{tastes}

Build it from these ingredients, picked at random so that every world is different:
- Setting: {setting}. Keep it exactly this: everything happens here, and every note and post is about this place and the people in it.
- Genre: {genre}
- Era or flavour: {era}
- What's wrong: {trouble}

Bend the genre, era and trouble to fit {name}'s tastes. Give it specifics only this world would have, and names that fit it rather than the first ones that come to mind.

Reply with JSON only, in this shape:
{"place": {"name": "...", "summary": "one sentence", "details": "one or two sentences: a custom or rule people here live by"},
"local": {"name": "...", "pronouns": "...", "age": "...", "personality": "one sentence", "background": "one or two sentences"},
"event": {"name": "...", "summary": "one sentence", "details": "one sentence"},
"character": {"name": "...", "age": "...", "role": "one line", "appearance": "one sentence", "personality": "one or two sentences", "background": "one or two sentences, with something unresolved", "speech": "one line"},
"partner": {"name": "...", "about": "two sentences: who they are, and what they want here"},
"channel": "a short name for the scene's channel, lowercase-with-hyphens",
"posts": ["...", "..."]}

`place`, `local` and `event` are notes about the world. `character` is someone {name} could play in a story set here. `partner` stands in for the user in the practice scene: someone arriving with a problem. `posts` are the partner's two posts in that scene, 80 to 150 words each, written ahead of time: roleplay prose, third person, with *actions in asterisks* and "dialogue in quotes". In the first, the partner arrives and asks whoever's there for help or answers, without naming anyone else. In the second, they press on with one concrete detail and a question. Neither post decides what anyone but the partner says or does.

## user

Make the world.
