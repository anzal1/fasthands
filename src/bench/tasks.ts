// The 5 benchmark tasks, per the fixture contract at the bottom of
// src/types.ts. Each task pairs a natural-language goal with a Playwright-
// backed DOM verifier that checks the *actual* success condition on the live
// page after the agent claims to be done (or after maxTurns is exhausted).
//
// FIXTURE_DATA is the single source of truth for the concrete values baked
// into the task descriptions below; src/bench/oracle.ts imports it so the
// scripted "competent model" fills in the same values the descriptions
// promise, rather than duplicating magic strings across two files.

import type { Page } from "playwright";
import type { BenchTask } from "../types.ts";

export const FIXTURE_DATA = {
  form: {
    name: "Dana Cruz",
    email: "dana@example.com",
    guests: "4",
    date: "2026-10-01",
    confirmationCode: "FH-2291",
  },
  search: {
    query: "pixelbook",
    target: "Pixelbook Lite",
  },
  checkout: {
    name: "Dana Cruz",
    address: "123 Market St",
    city: "San Francisco",
    orderId: "ORD-88412",
  },
  settings: {
    enable: ["Dark mode", "Email digest"],
    disable: ["Telemetry"],
  },
  list: {
    target: "Order #4711",
  },
  signup: {
    email: "sam@example.com",
    // The trap: these are the values the task description asks for, and they
    // violate the fixture's hidden rules (username needs 5-15 chars,
    // password needs 8+ incl. a digit). A loop without xray discovers that
    // by failing a submit; a loop with xray reads the rules up front.
    naiveUsername: "sam",
    naivePassword: "hunter2",
    validUsername: "sam_1",
    validPassword: "hunter22",
    date: "1999-05-05",
    welcomeCode: "FH-SIGNUP-77",
  },
} as const;

async function formVerify(pageUnknown: unknown): Promise<boolean> {
  try {
    const page = pageUnknown as Page;
    const code = (await page.locator("#confirmation-code").textContent({ timeout: 3000 }))?.trim();
    return code === FIXTURE_DATA.form.confirmationCode;
  } catch {
    return false;
  }
}

async function searchVerify(pageUnknown: unknown): Promise<boolean> {
  try {
    const page = pageUnknown as Page;
    const cartCount = (await page.locator("[data-cart-count]").first().textContent({ timeout: 3000 }))?.trim();
    const bodyText = (await page.locator("body").innerText()).toLowerCase();
    return cartCount === "1" && bodyText.includes(FIXTURE_DATA.search.target.toLowerCase());
  } catch {
    return false;
  }
}

async function checkoutVerify(pageUnknown: unknown): Promise<boolean> {
  try {
    const page = pageUnknown as Page;
    // checkout.html hardcodes the "Order placed" block (including
    // #order-id's text) in the initial markup and only toggles a wrapper's
    // display via JS — the element exists (and textContent() resolves)
    // whether or not the order was actually placed. isVisible() is the
    // actual success signal; textContent() alone would always be true.
    const orderIdLocator = page.locator("#order-id");
    const visible = await orderIdLocator.isVisible();
    const orderId = (await orderIdLocator.textContent({ timeout: 3000 }))?.trim();
    return visible && orderId === FIXTURE_DATA.checkout.orderId;
  } catch {
    return false;
  }
}

async function settingsVerify(pageUnknown: unknown): Promise<boolean> {
  try {
    const page = pageUnknown as Page;
    const status = page.locator('[role="status"]').first();
    const visible = await status.isVisible();
    const text = ((await status.textContent({ timeout: 3000 })) ?? "").trim();
    const darkMode = await page.locator('[data-setting="darkMode"]').getAttribute("aria-checked", { timeout: 3000 });
    const emailDigest = await page
      .locator('[data-setting="emailDigest"]')
      .getAttribute("aria-checked", { timeout: 3000 });
    const telemetry = await page
      .locator('[data-setting="telemetry"]')
      .getAttribute("aria-checked", { timeout: 3000 });
    return (
      visible &&
      text.includes("Preferences saved") &&
      darkMode === "true" &&
      emailDigest === "true" &&
      telemetry === "false"
    );
  } catch {
    return false;
  }
}

async function listVerify(pageUnknown: unknown): Promise<boolean> {
  try {
    const page = pageUnknown as Page;
    const headings = await page.locator("h1").allTextContents();
    return headings.some((h) => h.trim() === FIXTURE_DATA.list.target);
  } catch {
    return false;
  }
}

async function signupVerify(pageUnknown: unknown): Promise<boolean> {
  try {
    const page = pageUnknown as Page;
    const code = page.locator("#welcome-code");
    const visible = await code.isVisible();
    const text = (await code.textContent({ timeout: 3000 }))?.trim();
    return visible && text === FIXTURE_DATA.signup.welcomeCode;
  } catch {
    return false;
  }
}

export const tasks: BenchTask[] = [
  {
    id: "form",
    description:
      "Book a table for 4 under the name Dana Cruz, email dana@example.com, date 2026-10-01, then submit the reservation.",
    fixturePath: "/form",
    verify: formVerify,
  },
  {
    id: "search",
    description: "Find the cheapest laptop in the product search and add it to your cart.",
    fixturePath: "/search",
    verify: searchVerify,
  },
  {
    id: "checkout",
    description:
      "Check out: ship to Dana Cruz at 123 Market St, San Francisco, choose pay on delivery, and place the order.",
    fixturePath: "/checkout",
    verify: checkoutVerify,
  },
  {
    id: "settings",
    description: "Enable Dark mode and Email digest, disable Telemetry, then save your preferences.",
    fixturePath: "/settings",
    verify: settingsVerify,
  },
  {
    id: "list",
    description: "Find order #4711 in the order list and open its details.",
    fixturePath: "/list",
    verify: listVerify,
  },
  {
    id: "signup",
    description:
      'Create an account with email sam@example.com, username "sam", password "hunter2", birth date 1999-05-05, and accept the terms. If the site rejects any value, adjust it minimally until the account is created.',
    fixturePath: "/signup",
    verify: signupVerify,
  },
];

export default tasks;
