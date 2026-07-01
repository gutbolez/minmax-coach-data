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
  const ks = recommended(findBlock("Primary Runes"), "rune68")[0];
  const coreBlock = findBlock("Core Build");
  const core = coreBlock
    ? [...coreBlock.querySelectorAll("img[src*='item64']")].map((i) => idOf(i))
    : [];
  return { summoners, keystone: ks ? ks.alt : null, core, title: document.title };
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
    const coreItems = d.core.filter((id) => !bootsSet.has(id));
    if (coreItems.length) out.core = coreItems.slice(0, 3);
    const boots = d.core.find((id) => bootsSet.has(id));
    if (boots) out.boots = boots;
    return out;
  } catch {
    return {};
  } finally {
    await page.close();
  }
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
  let champs = Object.values(champData.data).map((c) => ({
    name: c.name,
    tags: c.tags || [],
    attack: c.info?.attack ?? 0,
    magic: c.info?.magic ?? 0,
  }));
  champs.sort((a, b) => a.name.localeCompare(b.name));
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
      const override = curated[champ.name] || {};
      if (live.summoners || live.keystone || live.core) scraped++;
      out[champ.name] = {
        summoners: override.summoners || live.summoners || base.summoners,
        keystone: override.keystone || live.keystone || base.keystone,
        ...((override.core || live.core) ? { core: override.core || live.core } : {}),
        ...((override.boots || live.boots) ? { boots: override.boots || live.boots } : {}),
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
    source: "lolalytics (scraped); champion roster from Riot Data Dragon",
    note: "Every champion present. Live scrape overlays a class default; curated.json overrides both.",
    champions: ordered,
  };
  writeFileSync(OUT, JSON.stringify(file, null, 2) + "\n");
  console.log(`Wrote meta.json: ${champs.length} champions, ${scraped} scraped live.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
