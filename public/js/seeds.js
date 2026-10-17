/**
 * The seed picker (design/kinwriter-generation/spec.md): where a new
 * kinwriter comes from. One dialog, one screen at a time:
 *
 *   entry    the default kinwriters as cards (name, pronouns, tagline), next
 *            to "Make a new one" (the tags) and "Generate from idea"
 *   tags     a required name choice (random name, random username, or
 *            typed), then five categories, each on "Surprise me" to start (personality
 *            takes several, as chips); Advanced, for
 *            a platform's or an influence's corner; "Surprise me, don't show me"
 *   details  the primary social media options, each with its era and tics
 *   idea     your own words, as much or as little as you like, and any
 *            tags you want to attach (the same pickers, kept apart from the
 *            tags screen's); categories left open come from your words
 *   preview  the seed: name, pronouns, tags as chips (🎲 for what chance
 *            picked), and the body; Reroll, Reroll the dice, Back to tags
 *            (or Back to idea), Edit, Accept
 *   edit     name, pronouns and the body; saving re-checks the headings
 *
 * Accept hands the seed to whoever opened the picker (the setup, or a new
 * kinwriter), which makes them at once. Nothing is saved before that.
 *
 * Every option, label and blurb comes from the tag files, by way of the
 * server (GET /api/seeds/tags): nothing about a particular tag is written
 * here. Dev mode (DEVELOPER_PANEL=1) adds Load test seed, Show prompt, Raw
 * output, Trace, Roll 5 and Check files; none of them exist otherwise.
 */

import { $, api, hideFormError, showFormError, state } from "./core.js";

/** What's open: who to hand the seed to, and where things stand. */
const picker = {
  /** `async (seedText) => void`: makes the kinwriter. */
  accept: null,
  /** The tag categories, as the server sent them. */
  categories: [],
  defaults: [],
  testSeed: null,
  /**
   * Your picks: { category: tagId | null } (null is "Surprise me"; personality
   * takes a list, [tagId, ...]), and chosen corners: { tagId: pocket }.
   */
  picks: {},
  pockets: {},
  /** Tags attached to an idea, the same shape: null is "From the idea". */
  ideaPicks: {},
  ideaPockets: {},
  /** What they'll be called: "" (not chosen yet), "name", "username" or "given", and the name you typed. */
  naming: "",
  givenName: "",
  /** The seed in the preview: { text, header, body, generation }, and how it was made ("tags", "idea", "default", "test"). */
  seed: null,
  made: null,
  /** The idea's text, for Try again and Reroll. */
  idea: "",
  /** The last failed seed: { expected, attempts: [{ raw, error, problems }] }, for "What they wrote". */
  failure: null,
  /** What Try again repeats. */
  retry: null,
  /** Where the dev screen goes back to. */
  devBack: "preview",
};

/** Open the picker. `accept(seedText)` makes the kinwriter. */
export async function openSeedPicker({ accept }) {
  picker.accept = accept;
  picker.seed = null;
  const dialog = $("seed-dialog");
  for (const element of dialog.querySelectorAll("[data-developer]")) element.hidden = !state.developerPanel;
  show("entry");
  // The entry screen is never blank: "Generate from idea" works without the
  // lists, so it's there at once, with a line saying the rest is on its way.
  setEntryStatus("loading");
  renderEntry();
  if (!dialog.open) dialog.showModal();
  try {
    const [seeds, tags] = await Promise.all([api("GET", "/api/seeds/defaults"), api("GET", "/api/seeds/tags")]);
    if (!Array.isArray(seeds?.defaults) || !Array.isArray(tags?.categories)) {
      throw new Error("The server sent something unexpected. If you just updated, restart the server and reload.");
    }
    picker.defaults = seeds.defaults.filter((d) => d?.header);
    picker.testSeed = seeds.test ?? null;
    picker.categories = tags.categories;
    for (const category of picker.categories) {
      if (!(category.id in picker.picks)) picker.picks[category.id] = null;
      if (!(category.id in picker.ideaPicks)) picker.ideaPicks[category.id] = null;
    }
    setEntryStatus(null);
  } catch (error) {
    console.warn(error);
    setEntryStatus("error", error.message);
  }
  renderEntry();
}

/** The line under the entry's cards: loading, why the lists didn't load, or nothing. */
function setEntryStatus(kind, message = "") {
  const loading = $("seed-entry-loading");
  const failed = $("seed-entry-error");
  loading.hidden = kind !== "loading";
  failed.hidden = kind !== "error";
  failed.textContent = kind === "error" ? `Couldn't load the ready-made kinwriters and tags: ${message}` : "";
}

/** Show one screen. */
function show(name) {
  for (const screen of $("seed-dialog").querySelectorAll(".seed-screen")) screen.hidden = screen.dataset.screen !== name;
  // The preview and edit screens have their own way out.
  $("seed-dialog").querySelector(".seed-close").hidden = ["busy"].includes(name);
}

// ------------------------------------------------------------------ entry

function card(title, lines, onClick, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `seed-card ${className}`.trim();
  const head = document.createElement("strong");
  head.textContent = title;
  button.append(head);
  for (const line of lines.filter(Boolean)) {
    const text = document.createElement("span");
    text.className = "hint";
    text.textContent = line;
    button.append(text);
  }
  button.addEventListener("click", onClick);
  return button;
}

function renderEntry() {
  const cards = picker.defaults.map((d) =>
    card(d.header.name, [d.header.pronouns, d.header.tagline], () => {
      picker.made = "default";
      setSeed({ text: d.text, header: d.header, body: d.body });
    }),
  );
  // "Make a new one" opens the tags, once there are any.
  if (picker.categories.length) cards.push(card("Make a new one", ["From tags you pick, or leave to chance."], () => openTags(), "seed-card-new"));
  cards.push(card("Generate from idea", ["Write a little or a lot, and get a whole person."], () => openIdea(), "seed-card-new"));
  $("seed-cards").replaceChildren(...cards);
}

// ------------------------------------------------------------------- tags

/**
 * Where a set of tag pickers draws and keeps its picks: the tags screen
 * (open categories are "Surprise me") or the idea screen (open categories
 * come from your words). Each keeps its own picks.
 */
const TAGS = {
  get picks() {
    return picker.picks;
  },
  get pockets() {
    return picker.pockets;
  },
  prefix: "seed",
  form: "seed-tags-form",
  pocketsBox: "seed-pockets",
  empty: "seed-advanced-empty",
  open: "Surprise me",
  openMulti: "Surprise me. Pick as many as you like, and they'll be blended into one person.",
};
const IDEA_TAGS = {
  get picks() {
    return picker.ideaPicks;
  },
  get pockets() {
    return picker.ideaPockets;
  },
  prefix: "seed-idea",
  form: "seed-idea-tags",
  pocketsBox: "seed-idea-pockets",
  empty: null,
  open: "From the idea",
  openMulti: "From the idea. Pick as many as you like, and they'll be blended into one person.",
};

function openTags() {
  hideFormError($("seed-dialog").querySelector('[data-screen="tags"]'));
  $("seed-naming").value = picker.naming;
  $("seed-given-name").value = picker.givenName;
  $("seed-given-name").hidden = picker.naming !== "given";
  renderTags(TAGS);
  renderPockets(TAGS);
  show("tags");
}

/** The idea screen: your words, and (folded away until you want them) tags to attach. */
function openIdea() {
  $("seed-idea-tagbox").hidden = picker.categories.length === 0;
  renderTags(IDEA_TAGS);
  renderPockets(IDEA_TAGS);
  updateIdeaSummary();
  show("idea");
}

/** "Attach tags (optional)", with how many are attached. */
function updateIdeaSummary() {
  const count = picker.categories.reduce((n, c) => n + picked(c.id, IDEA_TAGS).length, 0);
  $("seed-idea-tagbox-summary").textContent = count ? `Tags (${count} attached)` : "Attach tags (optional)";
}

/** The five categories, each a choice with "Surprise me" (or "From the idea") first. */
function renderTags(ctx) {
  const fields = picker.categories.map((category) => {
    const field = document.createElement("div");
    field.className = "seed-tag";
    const label = document.createElement("label");
    label.htmlFor = `${ctx.prefix}-tag-${category.id}`;
    label.textContent = category.label;
    field.append(label);
    if (category.subtitle) {
      // Primary social media's subtitle opens the details page.
      const link = document.createElement("button");
      link.type = "button";
      link.className = "link-button seed-subtitle";
      link.textContent = category.subtitle;
      link.addEventListener("click", () => openDetails(category, ctx));
      field.append(link);
    }
    if (category.multiple) {
      field.append(...multiPicker(category, ctx));
      return field;
    }
    const select = document.createElement("select");
    select.id = `${ctx.prefix}-tag-${category.id}`;
    select.append(new Option(ctx.open, ""));
    for (const option of category.options) {
      const item = new Option(option.label, option.id);
      item.title = option.blurb;
      select.append(item);
    }
    select.value = ctx.picks[category.id] ?? "";
    const blurb = document.createElement("p");
    blurb.className = "hint seed-blurb";
    const describe = () => {
      blurb.textContent = category.options.find((o) => o.id === select.value)?.blurb ?? "";
    };
    select.addEventListener("change", () => {
      ctx.picks[category.id] = select.value || null;
      // A corner belongs to its tag: a new pick starts on "Surprise me" again.
      for (const tag of Object.keys(ctx.pockets)) if (tag.startsWith(`${category.id}.`)) delete ctx.pockets[tag];
      describe();
      renderPockets(ctx);
    });
    describe();
    field.append(select, blurb);
    return field;
  });
  $(ctx.form).replaceChildren(...fields);
}

/** Your picks in a category, as a list (several for personality, else none or one). */
function picked(categoryId, ctx = TAGS) {
  const value = ctx.picks[categoryId];
  return Array.isArray(value) ? value : value ? [value] : [];
}

/** A category that takes several (personality): a chip per option to toggle. None picked is "Surprise me". */
function multiPicker(category, ctx) {
  const chips = document.createElement("div");
  chips.className = "seed-multi";
  chips.id = `${ctx.prefix}-tag-${category.id}`;
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", category.label);
  const blurb = document.createElement("p");
  blurb.className = "hint seed-blurb";
  const describe = () => {
    const chosen = picked(category.id, ctx).map((id) => category.options.find((o) => o.id === id)).filter(Boolean);
    blurb.textContent = chosen.length
      ? chosen.map((o) => (chosen.length > 1 ? `${o.label}: ${o.blurb}` : o.blurb)).join(" · ")
      : ctx.openMulti;
  };
  for (const option of category.options) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "seed-multi-chip";
    chip.textContent = option.label;
    chip.title = option.blurb;
    const sync = () => chip.setAttribute("aria-pressed", String(picked(category.id, ctx).includes(option.id)));
    chip.addEventListener("click", () => {
      const now = picked(category.id, ctx);
      const next = now.includes(option.id) ? now.filter((id) => id !== option.id) : [...now, option.id];
      ctx.picks[category.id] = next.length ? next : null;
      // A corner belongs to its tag: dropping the tag drops its corner.
      if (!next.includes(option.id)) delete ctx.pockets[option.id];
      sync();
      describe();
      renderPockets(ctx);
    });
    sync();
    chips.append(chip);
  }
  describe();
  return [chips, blurb];
}

/** Advanced: a corner for each picked tag that has them. None for a category still on "Surprise me". */
function renderPockets(ctx) {
  if (ctx === IDEA_TAGS) updateIdeaSummary();
  const rows = [];
  for (const category of picker.categories) {
    for (const tag of picked(category.id, ctx).map((id) => category.options.find((o) => o.id === id))) {
      if (!tag?.pockets.length) continue;
      const field = document.createElement("div");
      field.className = "seed-tag";
      const label = document.createElement("label");
      label.htmlFor = `${ctx.prefix}-pocket-${tag.id}`;
      label.textContent = `${tag.label}: which corner`;
      const select = document.createElement("select");
      select.id = `${ctx.prefix}-pocket-${tag.id}`;
      select.append(new Option("Surprise me", ""));
      for (const pocket of tag.pockets) select.append(new Option(pocket.label, pocket.slug));
      select.value = ctx.pockets[tag.id] ?? "";
      const blurb = document.createElement("p");
      blurb.className = "hint seed-blurb";
      const describe = () => {
        const pocket = tag.pockets.find((p) => p.slug === select.value);
        blurb.textContent = pocket ? pocket.blurb : tag.pockets.map((p) => `${p.label}: ${p.blurb}`).join(" · ");
      };
      select.addEventListener("change", () => {
        if (select.value) ctx.pockets[tag.id] = select.value;
        else delete ctx.pockets[tag.id];
        describe();
      });
      describe();
      field.append(label, select, blurb);
      rows.push(field);
    }
  }
  $(ctx.pocketsBox).replaceChildren(...rows);
  if (ctx.empty) $(ctx.empty).hidden = rows.length > 0;
}

/** The details page: each option in a category, its blurb, era and tics. */
function openDetails(category, ctx = TAGS) {
  const sections = category.options.map((option) => {
    const section = document.createElement("section");
    section.className = "seed-detail";
    const head = document.createElement("h3");
    head.className = "section-title";
    head.textContent = option.label;
    const blurb = document.createElement("p");
    blurb.textContent = option.blurb;
    section.append(head, blurb);
    if (option.era) {
      const era = document.createElement("p");
      era.className = "hint";
      era.textContent = option.era;
      section.append(era);
    }
    if (option.tics?.length) {
      const list = document.createElement("ul");
      for (const tic of option.tics) {
        const item = document.createElement("li");
        item.textContent = tic;
        list.append(item);
      }
      section.append(list);
    }
    return section;
  });
  $("seed-details").replaceChildren(...sections);
  const back = $("seed-details-back");
  back.dataset.seedBack = ctx === IDEA_TAGS ? "idea" : "tags";
  back.textContent = ctx === IDEA_TAGS ? "Back to idea" : "Back to tags";
  show("details");
}

// ------------------------------------------------------------- generating

/** What the tags screen asks for: your picks, or (Reroll) the last seed's tags. */
function tagRequest(mode) {
  if (mode === "reroll" && picker.seed?.header) {
    const h = picker.seed.header;
    const rolledTags = h.rolled.filter((r) => !r.includes("#"));
    const tags = Object.fromEntries(
      picker.categories.map((c) => {
        const inCategory = h.tags.filter((t) => t.startsWith(`${c.id}.`));
        return [c.id, c.multiple ? (inCategory.length ? inCategory : null) : (inCategory[0] ?? null)];
      }),
    );
    return { tags, rolledTags, pockets: { ...picker.pockets }, naming: namingRequest() };
  }
  return { tags: { ...picker.picks }, rolledTags: [], pockets: { ...picker.pockets }, naming: namingRequest() };
}

/** The name choice, as the server takes it. */
function namingRequest() {
  // Roll 5 (dev) doesn't ask: a random name, unless you chose otherwise.
  return picker.naming === "given" ? { given: picker.givenName.trim() } : picker.naming || "name";
}

/** The name is required: a random name, a random username, or one you type. Says what's missing, if anything. */
function namingReady() {
  const screen = $("seed-dialog").querySelector('[data-screen="tags"]');
  hideFormError(screen);
  if (!picker.naming) {
    showFormError(screen, "Choose how they'll be named first.");
    $("seed-naming").focus();
    return false;
  }
  if (picker.naming === "given" && !picker.givenName.trim()) {
    showFormError(screen, "Type their name, or pick a random one.");
    $("seed-given-name").focus();
    return false;
  }
  return true;
}

/** Generate from the tags. `mode`: "fresh" (Make them), "reroll" or "dice". */
async function generateFromTags(mode = "fresh") {
  if (mode === "fresh" && !namingReady()) return;
  const body = tagRequest(mode);
  picker.made = "tags";
  await generate("/api/seeds/generate", body, () => generateFromTags(mode));
}

async function generateFromIdea() {
  const text = $("seed-idea-text").value.trim();
  if (!text) {
    $("seed-idea-text").focus();
    return;
  }
  picker.idea = text;
  picker.made = "idea";
  await generate("/api/seeds/idea", { text, tags: { ...picker.ideaPicks }, pockets: { ...picker.ideaPockets } }, () => generateFromIdea());
}

/** One generation (the server checks it, and tries once more if it fails). */
async function generate(path, body, again) {
  picker.retry = again;
  show("busy");
  $("seed-busy-text").textContent = "Writing their seed. This takes a moment.";
  try {
    const result = await api("POST", path, body);
    // "Surprise me, don't show me": straight to orientation (on the tags only).
    if (picker.made === "tags" && $("seed-blind").checked) {
      $("seed-busy-text").textContent = "Making them…";
      await picker.accept(result.text);
      $("seed-dialog").close();
      return;
    }
    setSeed(result);
  } catch (error) {
    $("seed-error-text").textContent = error.message;
    // Only when the model wrote something: a failure to reach it has nothing to show.
    picker.failure = error.data?.attempts?.some?.((a) => a.raw != null) ? error.data : null;
    $("seed-error-compare").hidden = !picker.failure;
    show("error");
  }
}

// ---------------------------------------------------------------- preview

function setSeed(seed) {
  picker.seed = seed;
  renderPreview();
  show("preview");
}

/** A seed's body as HTML: its headings, bullets and paragraphs. Built from text nodes, so nothing in it runs. */
function renderSeedBody(body) {
  const box = document.createDocumentFragment();
  let list = null;
  let paragraph = null;
  for (const line of body.split("\n")) {
    const heading = line.match(/^#{2,3}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      const h = document.createElement("h4");
      h.className = "self-subtitle";
      h.textContent = heading[1];
      box.append(h);
      list = paragraph = null;
    } else if (bullet) {
      if (!list) box.append((list = document.createElement("ul")));
      const item = document.createElement("li");
      item.textContent = bullet[1];
      list.append(item);
      paragraph = null;
    } else if (!line.trim()) {
      list = paragraph = null;
    } else if (list && /^\s/.test(line)) {
      list.lastElementChild.textContent += ` ${line.trim()}`;
    } else {
      if (!paragraph) box.append((paragraph = document.createElement("p")));
      paragraph.textContent += `${paragraph.textContent ? " " : ""}${line.trim()}`;
      list = null;
    }
  }
  return box;
}

/** A tag's label, from the tag files (or its id, if it's gone). */
function tagLabel(id) {
  for (const category of picker.categories) {
    const option = category.options.find((o) => o.id === id);
    if (option) return option.label;
  }
  return id;
}

function pocketLabel(tagId, slug) {
  for (const category of picker.categories) {
    const pocket = category.options.find((o) => o.id === tagId)?.pockets.find((p) => p.slug === slug);
    if (pocket) return pocket.label;
  }
  return slug;
}

function renderPreview() {
  const { header, body } = picker.seed;
  const dialog = $("seed-dialog");
  hideFormError(dialog.querySelector('[data-screen="preview"]'));
  $("seed-preview-name").textContent = header.name;
  $("seed-preview-pronouns").textContent = header.pronouns;
  // Chips: the tags, 🎲 on what chance picked, and chosen corners under their tag (rolled ones stay hidden).
  const rolled = new Set(header.rolled ?? []);
  const chips = (header.tags ?? []).map((tag) => {
    const chip = document.createElement("span");
    chip.className = "seed-chip";
    chip.textContent = `${rolled.has(tag) ? "🎲 " : ""}${tagLabel(tag)}`;
    if (rolled.has(tag)) chip.title = "Rolled";
    const chosen = (header.pockets ?? []).filter((p) => p.startsWith(`${tag}#`) && !rolled.has(p));
    if (chosen.length) {
      const wrap = document.createElement("span");
      wrap.className = "seed-chip-group";
      wrap.append(chip);
      for (const pocket of chosen) {
        const sub = document.createElement("span");
        sub.className = "seed-chip seed-subchip";
        sub.textContent = pocketLabel(tag, pocket.split("#")[1]);
        wrap.append(sub);
      }
      return wrap;
    }
    return chip;
  });
  $("seed-preview-chips").replaceChildren(...chips);
  $("seed-preview-body").replaceChildren(renderSeedBody(body));
  // Rerolls only for generated seeds; Reroll the dice only if chance picked something.
  const fromTags = picker.made === "tags";
  $("seed-reroll").hidden = !(fromTags || picker.made === "idea");
  $("seed-reroll-dice").hidden = !(fromTags && rolled.size > 0);
  // Back to what made them: the tags, or your idea (with its attached tags).
  $("seed-back-tags").hidden = !(fromTags || picker.made === "idea");
  $("seed-back-tags").textContent = picker.made === "idea" ? "Back to idea" : "Back to tags";
  $("seed-back-entry").hidden = fromTags || picker.made === "idea";
  $("seed-raw").hidden = $("seed-show-prompt").hidden = !state.developerPanel || !picker.seed.generation;
  $("seed-trace").hidden = !state.developerPanel || !(header.tags ?? []).length;
}

async function acceptSeed() {
  const button = $("seed-accept");
  button.disabled = true;
  try {
    await picker.accept(picker.seed.text);
    $("seed-dialog").close();
  } catch (error) {
    showFormError($("seed-dialog").querySelector('[data-screen="preview"]'), error.message);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------- edit

function openEdit() {
  const form = $("seed-edit-form");
  hideFormError(form);
  form.elements.name.value = picker.seed.header.name;
  form.elements.pronouns.value = picker.seed.header.pronouns;
  form.elements.body.value = picker.seed.body;
  show("edit");
}

/** The seed's header as a file again, with your changes (the server reads it the same way). */
function seedText(header, body) {
  const list = (items) => `[${(items ?? []).join(", ")}]`;
  const lines = [
    `id: ${header.id}`,
    `name: ${header.name}`,
    `pronouns: ${header.pronouns}`,
    `source: ${header.source}`,
    ...(header.tagline ? [`tagline: ${header.tagline}`] : []),
    `tags: ${list(header.tags)}`,
    `rolled: ${list(header.rolled)}`,
    `pockets: ${list(header.pockets)}`,
    `model: ${header.model ?? ""}`,
    `created: ${header.created}`,
    `seed_version: ${header.seed_version}`,
    ...(header.user_edited ? ["user_edited: true"] : []),
  ];
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

async function saveEdit(event) {
  event.preventDefault();
  const form = $("seed-edit-form");
  hideFormError(form);
  const header = { ...picker.seed.header, name: form.elements.name.value.trim(), pronouns: form.elements.pronouns.value.trim(), user_edited: true };
  const body = form.elements.body.value;
  const text = seedText(header, body);
  try {
    const check = await api("POST", "/api/seeds/check", { text });
    if (!check.ok) {
      showFormError(form, check.problems.join(" "));
      return;
    }
    setSeed({ ...picker.seed, text, header, body: body.trim() });
  } catch (error) {
    showFormError(form, error.message);
  }
}

// -------------------------------------------------------------- dev mode

/** One dev view: a title and some blocks of text (each with a heading). */
function showDev(title, blocks, back = "preview") {
  picker.devBack = back;
  $("seed-dev-title").textContent = title;
  $("seed-dev-body").replaceChildren(
    ...blocks.map(({ heading, text, node }) => {
      const section = document.createElement("section");
      if (heading) {
        const h = document.createElement("h4");
        h.className = "self-subtitle";
        h.textContent = heading;
        section.append(h);
      }
      if (node) section.append(node);
      else {
        const pre = document.createElement("pre");
        pre.className = "developer-item";
        pre.textContent = text ?? "";
        section.append(pre);
      }
      return section;
    }),
  );
  show("dev");
}

/** A failed seed: what it needed, then each try's problems and what it actually wrote. */
function showFailure() {
  const { expected = [], attempts = [] } = picker.failure ?? {};
  showDev(
    "What they wrote",
    [
      ...(expected.length ? [{ heading: "What a seed needs", text: expected.map((rule) => `• ${rule}`).join("\n") }] : []),
      ...attempts.map((a, i) => ({
        heading: `Try ${i + 1}`,
        text: `${a.problems.map((p) => `✗ ${p}`).join("\n")}${a.problems.length ? "\n\n" : ""}${a.raw ?? a.error ?? ""}` || "(nothing came back)",
      })),
    ],
    "error",
  );
}

async function showLast(what, back = "preview") {
  try {
    const last = await api("GET", "/api/seeds/last");
    if (!last.generation) return showDev("Nothing yet", [{ text: "No seed has been generated since the server started." }], back);
    const g = last.generation;
    if (what === "prompt") showDev("Show prompt", [{ heading: "System prompt", text: g.system }, { heading: "User message", text: g.user }], back);
    else
      showDev(
        "Raw output",
        g.attempts.map((a, i) => ({
          heading: `Attempt ${i + 1}: ${a.problems.length ? `failed: ${a.problems.map((p) => p.check).join(", ")}` : "passed"}`,
          text: `${a.problems.map((p) => `✗ ${p.message}`).join("\n")}${a.problems.length ? "\n\n" : ""}${a.raw ?? a.error ?? ""}`,
        })),
        back,
      );
  } catch (error) {
    showDev("Dev", [{ text: error.message }], back);
  }
}

/** Trace: the tags, rolled tags and pockets behind a seed, each linking to its tag file. */
function traceNode(header, onOpen) {
  const list = document.createElement("ul");
  const rolled = new Set(header.rolled ?? []);
  const item = (id, kind) => {
    const li = document.createElement("li");
    const link = document.createElement("button");
    link.type = "button";
    link.className = "link-button";
    link.textContent = id;
    link.addEventListener("click", () => onOpen(id.split("#")[0]));
    li.append(`${kind}${rolled.has(id) ? " (rolled)" : " (picked)"}: `, link);
    return li;
  };
  for (const tag of header.tags ?? []) list.append(item(tag, "Tag"));
  for (const pocket of header.pockets ?? []) list.append(item(pocket, "Pocket"));
  if (!list.children.length) list.append(Object.assign(document.createElement("li"), { textContent: "No tags: written by hand." }));
  return list;
}

async function openTagFile(id, back) {
  try {
    const { file, text } = await api("GET", `/api/seeds/tag-file?id=${encodeURIComponent(id)}`);
    showDev(file, [{ text }], back);
  } catch (error) {
    showDev(id, [{ text: error.message }], back);
  }
}

function showTrace() {
  const header = picker.seed.header;
  showDev("Trace", [{ heading: `${header.name}: ${header.source}${header.model ? `, ${header.model}` : ""}`, node: traceNode(header, (id) => openTagFile(id, "dev")) }]);
}

async function rollFive() {
  show("busy");
  $("seed-busy-text").textContent = "Rolling five, side by side. Nothing is saved.";
  try {
    const { seeds } = await api("POST", "/api/seeds/roll5", tagRequest("fresh"));
    const grid = document.createElement("div");
    grid.className = "seed-roll5";
    for (const seed of seeds) {
      const column = document.createElement("article");
      column.className = "seed-roll5-item";
      const head = document.createElement("h4");
      head.textContent = seed.header ? `${seed.header.name} (${seed.header.pronouns})` : "Failed";
      column.append(head);
      if (seed.header) {
        const tags = document.createElement("p");
        tags.className = "hint";
        tags.textContent = seed.header.tags.map((t) => `${seed.header.rolled.includes(t) ? "🎲" : ""}${tagLabel(t)}`).join(" · ");
        const pockets = document.createElement("p");
        pockets.className = "hint";
        pockets.textContent = seed.header.pockets.join(", ");
        column.append(tags, pockets, renderSeedBody(seed.body));
      } else {
        column.append(Object.assign(document.createElement("p"), { className: "form-error", textContent: seed.error }));
      }
      grid.append(column);
    }
    showDev("Roll 5", [{ node: grid }], "tags");
  } catch (error) {
    showDev("Roll 5", [{ text: error.message }], "tags");
  }
}

async function checkFiles() {
  try {
    const { problems, checked } = await api("GET", "/api/seeds/check-files");
    showDev("Check files", [{ text: problems.length ? problems.map((p) => `✗ ${p.file}: ${p.message}`).join("\n") : `✓ All ${checked} files pass.` }], "entry");
  } catch (error) {
    showDev("Check files", [{ text: error.message }], "entry");
  }
}

/** Seed vs. self (dev mode, their page): their seed.md and self.md side by side, without telling them. */
export async function openSeedVsSelf() {
  const dialog = $("seed-dialog");
  for (const element of dialog.querySelectorAll("[data-developer]")) element.hidden = !state.developerPanel;
  try {
    const data = await api("GET", "/api/developer");
    const grid = document.createElement("div");
    grid.className = "seed-roll5";
    for (const [title, text] of [["seed.md", data.seed ?? "(No seed: they were written by hand, or made before seeds.)"], ["self.md", data.selfNotes]]) {
      const column = document.createElement("article");
      column.className = "seed-roll5-item";
      const head = document.createElement("h4");
      head.textContent = title;
      const pre = document.createElement("pre");
      pre.className = "developer-item";
      pre.textContent = text;
      column.append(head, pre);
      grid.append(column);
    }
    const blocks = [{ node: grid }];
    if (data.seedHeader) blocks.push({ heading: "Trace", node: traceNode(data.seedHeader, (id) => openTagFile(id, "seed-vs-self")) });
    showDev("Seed vs. self", blocks, "close");
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    alert(error.message);
  }
}

// ----------------------------------------------------------------- wiring

$("seed-dialog").addEventListener("click", (event) => {
  const back = event.target.closest("[data-seed-back]");
  if (!back) return;
  if (back.dataset.seedBack === "tags") openTags();
  else if (back.dataset.seedBack === "idea") openIdea();
  else show(back.dataset.seedBack);
});
$("seed-test").addEventListener("click", () => {
  if (!picker.testSeed) return;
  picker.made = "test";
  // The same preview and Accept as any other seed.
  api("POST", "/api/seeds/parse", { text: picker.testSeed })
    .then((seed) => setSeed(seed))
    .catch((error) => alert(error.message));
});
$("seed-generate").addEventListener("click", () => generateFromTags("fresh"));
$("seed-naming").addEventListener("change", () => {
  picker.naming = $("seed-naming").value;
  $("seed-given-name").hidden = picker.naming !== "given";
  if (picker.naming === "given") $("seed-given-name").focus();
});
$("seed-given-name").addEventListener("input", () => {
  picker.givenName = $("seed-given-name").value;
});
$("seed-idea-generate").addEventListener("click", generateFromIdea);
$("seed-reroll").addEventListener("click", () => (picker.made === "idea" ? generateFromIdea() : generateFromTags("reroll")));
$("seed-reroll-dice").addEventListener("click", () => generateFromTags("dice"));
$("seed-back-tags").addEventListener("click", () => (picker.made === "idea" ? openIdea() : openTags()));
$("seed-back-entry").addEventListener("click", () => show("entry"));
$("seed-edit").addEventListener("click", openEdit);
$("seed-edit-cancel").addEventListener("click", () => show("preview"));
$("seed-edit-form").addEventListener("submit", saveEdit);
$("seed-accept").addEventListener("click", acceptSeed);
$("seed-retry").addEventListener("click", () => picker.retry?.());
$("seed-error-back").addEventListener("click", () => (picker.made === "idea" ? openIdea() : openTags()));
$("seed-error-raw").addEventListener("click", () => showLast("raw", "error"));
$("seed-error-compare").addEventListener("click", showFailure);
$("seed-show-prompt").addEventListener("click", () => showLast("prompt"));
$("seed-raw").addEventListener("click", () => showLast("raw"));
$("seed-trace").addEventListener("click", showTrace);
$("seed-roll5").addEventListener("click", rollFive);
$("seed-check-files").addEventListener("click", checkFiles);
$("seed-dev-back").addEventListener("click", () => {
  if (picker.devBack === "close") $("seed-dialog").close();
  else if (picker.devBack === "seed-vs-self") openSeedVsSelf();
  else if (picker.devBack === "dev") showTrace();
  else if (picker.devBack === "tags") openTags();
  else show(picker.devBack);
});
