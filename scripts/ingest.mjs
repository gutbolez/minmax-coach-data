// Build meta.json for EVERY champion by scraping lolalytics with a headless
// browser.
//
// Why a browser: lolalytics renders its build data on the server into a
// JavaScript app, with no plain JSON API we can call. A headless browser runs
// their page and we read the finished, labelled build straight from the DOM
// (recommended summoners, keystone, and core items are the non-dimmed icons).
// This is robust to their internal data format because we read the rendered
// result, the same thing a human sees.
//
// Layering (last wins): archetype default -> live scrape -> curated override.
//   - Archetype default guarantees every champion has a sane call even if a
//     scrape fails.
//   - The live scrape is the point: current meta for all champions.
//   - curated.json lets you FORCE a value you disagree with; it wins over the
//     scrape. Leave it empty to let live data drive everything.
//
// Run: node scripts/ingest.mjs   (env: TIER, LIMIT, CONCURRENCY, HEADFUL)

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const DD = "https://ddragon.leagueoflegends.com";
const TIER = process.env.TIER || "diamond_plus";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const CURATED = new URL("../curated.json", import.meta.url);
const OUT = new URL("../meta.json", import.meta.url);

const getJson = async (u) => {
  const r = await fetch(u, { headers: { "user-agent": "minmax-coach-data/1.0" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`);
  return r.json();
};

// lolalytics champion slug: lowercase, alphanumeric only, with a few specials.
const slug = (name) => {
  const special = { "Nunu & Willump": "nunu", "Renata Glasc": "renata" };
  return special[name] || name.toLowerCase().replace(/[^a-z0-9]/g, "");
};

function archetype(champ) {
  const has = (t) => champ.tags.includes(t);
  let cls = "Bruiser";
  if (has("Tank")) cls = "Tank";
  else if (has("Marksman")) cls = "Marksman";
  else if (has("Assassin")) cls = "Assassin";
  else if (has("Mage")) cls = "Mage";
  else if (has("Fighter")) cls = "Bruiser";
  else if (has("Support")) cls = "Enchanter";
  else if (champ.magic - champ.attack >= 3) cls = "Mage";
  switch (cls) {
    case "Marksman": return { summoners: "Flash + Heal", keystone: "Lethal Tempo" };
    case "Assassin": return { summoners: "Flash + Ignite", keystone: "Electrocute" };
    case "Mage": return { summoners: "Flash + Ignite", keystone: "Electrocute" };
    case "Tank": return { summoners: "Flash + Teleport", keystone: "Grasp of the Undying" };
    case "Enchanter": return { summoners: "Flash + Ignite", keystone: "Summon Aery" };
    default: return { summoners: "Flash + Teleport", keystone: "Conqueror" };
  }
}

// Runs in the page: read the recommended (non-dimmed) build icons.
const EXTRACT = () => {
  const findBlock = (label) => {
    const el = [...document.querySelectorAll("*")].find(
      (n) => n.childElementCount <= 2 && (n.textContent || "").trim() === label
    );
    return el ? el.parentElement : null;
  };
  const recommended = (block, type) =>
    block
      ? [...block.querySelectorAll(`img[src*='${type}']`)].filter(
          (i) => getComputedStyle(i).opacity === "1" && !i.className.includes("grayscale")
        )
      : [];
  const idOf = (i) => { const m = i.src.match(/\/(\d+)\.webp/); return m ? Number(m[1]) : 0; };
  const summoners = recommended(findBlock("Summoner Spells"), "spell64").slice(0, 2).map((i) => i.alt);
  const primary = recommended(findBlock("Primary Runes"), "rune68");
  const secondary = recommended(findBlock("Secondary"), "rune68");
  const runePage = [...primary, ...secondary].map((i) => i.alt);
  const coreBlock = findBlock("Core Build");
  const core = coreBlock ? [...coreBlock.querySelectorAll("img[src*='item64']")].map(idOf) : [];
  // Items 4-6: the most-picked option in each later slot. Without these the
  // app falls back to class stat-matching mid game, which misfires on champs
  // whose class tag doesn't match their build (e.g. Gangplank: Fighter tag,
  // crit build) — a real user report.
  for (const label of ["Item 4", "Item 5", "Item 6"]) {
    const b = findBlock(label);
    const img = b && b.querySelector("img[src*='item64']");
    if (img) core.push(idOf(img));
  }
  const startBlock = findBlock("Starting Items");
  const starting = startBlock ? [...startBlock.querySelectorAll("img[src*='item64']")].map((i) => i.alt) : [];

  // Skill max priority (e.g. "E > Q > W"). lolalytics renders ability icons as
  // <champ>_<qwer>.webp; the page's icon sequence is [Q W E R] legend, then the
  // 3 abilities IN PRIORITY ORDER, then a [Q W E R] grid label row. The middle
  // triplet is the max order (verified: Garen E>Q>W, LeBlanc W>Q>E, Janna
  // E>W>Q). Only emit when the shape matches exactly, so a partial load can
  // never produce a wrong order.
  const abil = [...document.querySelectorAll("img")]
    .map((i) => (i.src.match(/_([qwer])\.webp/i) || [])[1])
    .filter(Boolean)
    .map((s) => s.toUpperCase());
  let skill = null;
  if (abil.length === 11 && abil.slice(0, 4).join("") === "QWER" && abil.slice(7, 11).join("") === "QWER") {
    const mid = abil.slice(4, 7);
    if ([...mid].sort().join("") === "EQW") skill = mid.join(" > ");
  }

  // Stat shards (the three rune stat mods to pick): 3 rows x 3 options rendered
  // as img[src*='statmod32']; the chosen one per row is full-opacity, not
  // grayscale. Map ids to short names so the app shows "Adaptive · Adaptive ·
  // Health" the way it shows the rune page.
  const SHARD = { 5008: "Adaptive", 5005: "Attack Speed", 5007: "Ability Haste", 5010: "Move Speed", 5001: "Health Scaling", 5011: "Health", 5013: "Tenacity" };
  const chosenShards = [...document.querySelectorAll("img[src*='statmod32']")]
    .filter((i) => getComputedStyle(i).opacity === "1" && !i.className.includes("grayscale"))
    .map((i) => Number((i.src.match(/statmod32\/(\d+)/) || [])[1]));
  const shards = chosenShards.length === 3 ? chosenShards.map((id) => SHARD[id] || id).join(" · ") : null;

  return { summoners, keystone: primary[0] ? primary[0].alt : null, runePage, core, starting, skill, shards, title: document.title };
};

async function scrape(context, champ, bootsSet) {
  const page = await context.newPage();
  // Skip images/ads/fonts to load faster; we only need the DOM + layout.
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (["media", "font"].includes(t)) return route.abort();
    route.continue();
  });
  try {
    await page.goto(`https://lolalytics.com/lol/${slug(champ.name)}/build/?tier=${TIER}`, {
      waitUntil: "domcontentloaded",
      timeout: 40000,
    });
    await page.waitForSelector("text=Core Build", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const d = await page.evaluate(EXTRACT);

    const out = {};
    if (d.summoners.length === 2) {
      d.summoners.sort((a, b) => (a === "Flash" ? -1 : b === "Flash" ? 1 : 0));
      out.summoners = `${d.summoners[0]} + ${d.summoners[1]}`;
    }
    if (d.keystone) out.keystone = d.keystone;
    // Full rune page (keystone + primary + secondary): a copyable summary.
    if (d.runePage && d.runePage.length > 1) out.runes = d.runePage.join(" · ");
    const coreItems = [...new Set(d.core.filter((id) => !bootsSet.has(id)))];
    if (coreItems.length) out.core = coreItems.slice(0, 5);
    const boots = d.core.find((id) => bootsSet.has(id));
    if (boots) out.boots = boots;
    const start = (d.starting || []).filter(Boolean).slice(0, 3);
    if (start.length) out.starting = start.join(" + ");
    if (d.skill) out.skill = d.skill;
    if (d.shards) out.shards = d.shards;
    return out;
  } catch {
    return {};
  } finally {
    await page.close();
  }
}

// ---- op.gg counters (real matchup winrates) ---------------------------------
//
// op.gg server-renders each champion's matchup table as structured JSON inside
// the page's RSC flight data: { play, win, win_rate, champion: { key, name } }.
// win_rate is the PAGE champion's winrate vs that opponent (verified: Yasuo vs
// Annie 44.6, vs Riven 36.9). So this champion's COUNTERS are the opponents it
// scores worst against, and the counter's winrate into it is 100 - win_rate.
// Plain fetch, no browser needed.

async function fetchCounters(ddId, keyToName) {
  const url = `https://op.gg/lol/champions/${ddId.toLowerCase()}/counters?tier=${TIER}`;
  let html;
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126" },
    });
    if (!r.ok) return null;
    html = await r.text();
  } catch {
    return null;
  }
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) =>
    JSON.parse('"' + m[1] + '"')
  );
  const flight = chunks.join("");
  const idx = flight.indexOf('"data":[{"play"');
  if (idx < 0) return null;
  const start = flight.indexOf("[", idx);
  let depth = 0;
  let end = start;
  for (let i = start; i < flight.length; i++) {
    const ch = flight[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (!depth) {
        end = i + 1;
        break;
      }
    }
  }
  let rows;
  try {
    rows = JSON.parse(flight.slice(start, end));
  } catch {
    return null;
  }
  const counters = rows
    .filter((e) => e && e.champion && typeof e.win_rate === "number" && e.play >= 150)
    .sort((a, b) => a.win_rate - b.win_rate)
    .slice(0, 6)
    .filter((e) => e.win_rate < 50) // only real counters, not even matchups
    .map((e) => ({
      c: keyToName.get(String(e.champion.key).toLowerCase()) || e.champion.name,
      wr: Math.round((100 - e.win_rate) * 10) / 10,
    }));
  return counters.length ? counters : null;
}

async function launchBrowser() {
  for (const opts of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try {
      return await chromium.launch({ headless: !process.env.HEADFUL, ...opts });
    } catch {}
  }
  throw new Error("no chromium/chrome/edge browser available");
}

async function main() {
  const ver = (await getJson(`${DD}/api/versions.json`))[0];
  const champData = await getJson(`${DD}/cdn/${ver}/data/en_US/championFull.json`);
  const items = await getJson(`${DD}/cdn/${ver}/data/en_US/item.json`);
  const bootsSet = new Set(
    Object.entries(items.data)
      .filter(([, it]) => (it.tags || []).includes("Boots"))
      .map(([id]) => Number(id))
  );
  const curated = JSON.parse(readFileSync(CURATED, "utf8")).champions ?? {};
  let champs = Object.entries(champData.data).map(([ddId, c]) => ({
    ddId,
    name: c.name,
    tags: c.tags || [],
    attack: c.info?.attack ?? 0,
    magic: c.info?.magic ?? 0,
  }));
  champs.sort((a, b) => a.name.localeCompare(b.name));
  // lowercase ddragon id -> display name, for resolving op.gg opponent keys.
  const keyToName = new Map(champs.map((c) => [c.ddId.toLowerCase(), c.name]));
  if (Number.isFinite(LIMIT)) champs = champs.slice(0, LIMIT);

  console.log(`Patch ${ver}: scraping ${champs.length} champions @ ${TIER}, concurrency ${CONCURRENCY}`);
  const browser = await launchBrowser();
  const context = await browser.newContext();

  const out = {};
  let scraped = 0;
  let idx = 0;
  async function worker() {
    while (idx < champs.length) {
      const champ = champs[idx++];
      const base = archetype(champ);
      const live = await scrape(context, champ, bootsSet);
      const counters = process.env.OPGG === "0" ? null : await fetchCounters(champ.ddId, keyToName);
      const override = curated[champ.name] || {};
      if (live.summoners || live.keystone || live.core) scraped++;
      out[champ.name] = {
        summoners: override.summoners || live.summoners || base.summoners,
        keystone: override.keystone || live.keystone || base.keystone,
        ...((override.runes || live.runes) ? { runes: override.runes || live.runes } : {}),
        ...((override.core || live.core) ? { core: override.core || live.core } : {}),
        ...((override.boots || live.boots) ? { boots: override.boots || live.boots } : {}),
        ...((override.starting || live.starting) ? { starting: override.starting || live.starting } : {}),
        ...((override.skill || live.skill) ? { skill: override.skill || live.skill } : {}),
        ...((override.shards || live.shards) ? { shards: override.shards || live.shards } : {}),
        ...(counters ? { counters } : {}),
      };
      if ((idx % 20) === 0) console.log(`  ${idx}/${champs.length}...`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();

  const ordered = {};
  for (const name of Object.keys(out).sort()) ordered[name] = out[name];
  const file = {
    patch: ver,
    tier: TIER,
    source: "builds/runes from lolalytics; counters from op.gg; roster from Riot Data Dragon",
    note: "Every champion present. Live scrape overlays a class default; curated.json overrides both.",
    champions: ordered,
  };
  writeFileSync(OUT, JSON.stringify(file, null, 2) + "\n");
  console.log(`Wrote meta.json: ${champs.length} champions, ${scraped} scraped live.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
