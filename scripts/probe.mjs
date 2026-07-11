import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext();
const page = await ctx.newPage();
await page.goto("https://lolalytics.com/lol/nasus/build/?tier=diamond_plus", { waitUntil: "domcontentloaded", timeout: 40000 });
await page.waitForTimeout(1500);
const info = await page.evaluate(() => {
  // find lane navigation links + their pick shares
  const links = [...document.querySelectorAll("a[href*='lane=']")].map(a => ({ href: a.getAttribute('href'), text: a.textContent.trim().slice(0,40) }));
  const title = document.title;
  return { title, links: links.slice(0, 12) };
});
console.log(JSON.stringify(info, null, 2));
await b.close();
