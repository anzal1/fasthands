// fasthands xray — reads the browser's own declarative form contract
// (required/pattern/type/min/max/minlength/maxlength/step/autocomplete) and
// its native validation engine (checkValidity/ValidityState/validationMessage)
// and turns both into annotations + preflight checks. The thesis: HTML is a
// self-describing API that no agent framework reads. We read it so error
// recovery costs zero model turns.
//
// Builds on the observe/ convention: every element the model can act on
// carries a `data-fh-ref` attribute (e.g. "e13"). xray never edits that
// convention's source — it only queries the DOM for it.

import type { Page } from "playwright";

export interface Violation {
  ref: string | null;
  field: string;
  rule: string;
  message: string;
}

export interface XrayAnnotations {
  text: string;
  approxTokens: number;
  count: number;
}

export interface Xray {
  annotate(refsInObservation: string[]): Promise<XrayAnnotations>;
  preflight(submitRef: string): Promise<Violation[]>;
}

const MAX_ANNOTATION_LINES = 150;

export function createXray(page: Page): Xray {
  async function annotate(refsInObservation: string[]): Promise<XrayAnnotations> {
    const lines = await page.evaluate((refs: string[]): string[] => {
      // ---------- helpers (self-contained: this whole function is shipped
      // to the browser context as source, so nothing outside this closure
      // is reachable) ----------

      function accessibleName(el: Element): string {
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const parts = labelledby
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim())
            .filter((t): t is string => Boolean(t));
          if (parts.length) return parts.join(" ");
        }

        const id = el.getAttribute("id");
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl?.textContent?.trim()) return lbl.textContent.trim();
        }

        const closestLabel = el.closest("label");
        if (closestLabel?.textContent?.trim()) return closestLabel.textContent.trim();

        const placeholder = el.getAttribute("placeholder");
        if (placeholder?.trim()) return placeholder.trim();

        if (el.tagName === "A" || el.tagName === "BUTTON" || el.tagName === "SUMMARY") {
          const txt = el.textContent?.trim();
          if (txt) return txt;
        }

        if (el.tagName === "INPUT") {
          const type = (el.getAttribute("type") || "").toLowerCase();
          if (type === "submit" || type === "button" || type === "reset") {
            const val = el.getAttribute("value");
            if (val?.trim()) return val.trim();
          }
        }

        return el.getAttribute("name") || id || el.tagName.toLowerCase();
      }

      function hasHint(el: Element): boolean {
        const title = el.getAttribute("title");
        if (title && title.trim()) return true;
        const describedby = el.getAttribute("aria-describedby");
        if (describedby) {
          for (const id of describedby.split(/\s+/)) {
            const node = document.getElementById(id);
            if (node?.textContent?.trim()) return true;
          }
        }
        return false;
      }

      // Splits a pattern into its lookahead assertions + the remainder, so
      // both the static description and the dynamic failure-reason logic
      // can share the same parse.
      function splitPattern(pattern: string): { lookaheads: string[]; rest: string } {
        const lookaheads: string[] = [];
        const laRe = /\(\?=([^)]*)\)/g;
        let m: RegExpExecArray | null;
        while ((m = laRe.exec(pattern)) !== null) {
          lookaheads.push(m[1]);
        }
        const rest = pattern.replace(laRe, "");
        return { lookaheads, rest };
      }

      function lookaheadWord(la: string): string {
        if (/\\d/.test(la)) return "a digit";
        if (/A-Z/.test(la) || /\\p\{Lu\}/i.test(la)) return "an uppercase letter";
        if (/a-z/.test(la) || /\\p\{Ll\}/i.test(la)) return "a lowercase letter";
        return "a symbol";
      }

      function lengthQuantifier(
        rest: string,
      ): { min: number; max?: number; phrase: string } | null {
        const qm = rest.match(/\{(\d+)(,(\d*))?\}/);
        if (!qm) return null;
        const min = parseInt(qm[1], 10);
        const hasComma = qm[2] !== undefined;
        const max = qm[3] ? parseInt(qm[3], 10) : undefined;
        let phrase: string;
        if (!hasComma) phrase = `${min} chars`;
        else if (max !== undefined) phrase = `${min}-${max} chars`;
        else phrase = `${min}+ chars`;
        return { min, max, phrase };
      }

      // Static, full description of a pattern's contract (used in the
      // per-field annotation line).
      function humanizePattern(pattern: string): string {
        const { lookaheads, rest } = splitPattern(pattern);
        const words = lookaheads.map(lookaheadWord);
        const q = lengthQuantifier(rest);
        if (q && words.length) return `${q.phrase} incl. ${words.join(" and ")}`;
        if (q) return q.phrase;
        if (words.length) return `needs ${words.join(" and ")}`;
        return `pattern: ${pattern}`;
      }

      // Dynamic description of WHY a pattern currently fails against a live
      // value (used in the submit-button BLOCKED consequence, so "needs a
      // digit" is reported instead of the whole static contract when the
      // value already satisfies everything else).
      function patternFailureReason(pattern: string, value: string): string {
        const { lookaheads, rest } = splitPattern(pattern);
        const failedWords: string[] = [];
        for (const la of lookaheads) {
          try {
            if (!new RegExp(la).test(value)) failedWords.push(lookaheadWord(la));
          } catch {
            // unparsable lookahead fragment; skip it
          }
        }
        const q = lengthQuantifier(rest);
        const lengthFailed = q ? value.length < q.min || (q.max !== undefined && value.length > q.max) : false;

        const parts: string[] = [];
        if (lengthFailed && q) parts.push(q.phrase);
        if (failedWords.length) parts.push(`needs ${failedWords.join(" and ")}`);
        if (parts.length === 0) return humanizePattern(pattern);
        return parts.join(", ");
      }

      function contractFacts(el: Element): { facts: string[]; hidden: boolean } {
        const facts: string[] = [];
        let hidden = false;
        const tag = el.tagName;
        const isFormControl = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
        if (!isFormControl) return { facts, hidden };

        if (el.hasAttribute("required")) facts.push("required");

        if (tag === "INPUT") {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          const formatMap: Record<string, string> = {
            email: "email format",
            url: "url format",
            number: "number format",
            date: "date format",
            tel: "tel format",
          };
          if (formatMap[type]) facts.push(formatMap[type]);
        }

        const pattern = el.getAttribute("pattern");
        if (pattern) {
          facts.push(humanizePattern(pattern));
          if (!hasHint(el)) hidden = true;
        }

        const min = el.getAttribute("min");
        const max = el.getAttribute("max");
        if (min !== null && max !== null) facts.push(`range ${min}-${max}`);
        else if (min !== null) facts.push(`min ${min}`);
        else if (max !== null) facts.push(`max ${max}`);

        const minlength = el.getAttribute("minlength");
        const maxlength = el.getAttribute("maxlength");
        if (minlength !== null && maxlength !== null) facts.push(`${minlength}-${maxlength} chars`);
        else if (minlength !== null) facts.push(`min length ${minlength}`);
        else if (maxlength !== null) facts.push(`max length ${maxlength}`);

        const step = el.getAttribute("step");
        if (step !== null) facts.push(`step ${step}`);

        const autocomplete = el.getAttribute("autocomplete");
        if (autocomplete) facts.push(`autocomplete: ${autocomplete}`);

        return { facts, hidden };
      }

      interface FormControlLike extends Element {
        checkValidity(): boolean;
        validity: ValidityState;
        validationMessage: string;
        willValidate: boolean;
        value: string;
        form: HTMLFormElement | null;
      }

      function isSubmitControl(el: Element): boolean {
        const tag = el.tagName;
        if (tag === "INPUT") {
          return (el.getAttribute("type") || "").toLowerCase() === "submit";
        }
        if (tag === "BUTTON") {
          const type = el.getAttribute("type");
          return type === null || type.toLowerCase() === "submit";
        }
        return false;
      }

      function isResetControl(el: Element): boolean {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "BUTTON") {
          return (el.getAttribute("type") || "").toLowerCase() === "reset";
        }
        return false;
      }

      function shortRuleFor(c: FormControlLike): string {
        const v = c.validity;
        if (v.valueMissing) return "required";
        if (v.typeMismatch) {
          const type = (c.getAttribute("type") || "").toLowerCase();
          const formatMap: Record<string, string> = {
            email: "email format",
            url: "url format",
            number: "number format",
            date: "date format",
            tel: "tel format",
          };
          return formatMap[type] || "invalid format";
        }
        if (v.patternMismatch) {
          const pattern = c.getAttribute("pattern");
          return pattern ? patternFailureReason(pattern, c.value) : "invalid format";
        }
        if (v.tooShort) return `min length ${c.getAttribute("minlength")}`;
        if (v.tooLong) return `max length ${c.getAttribute("maxlength")}`;
        if (v.rangeUnderflow) return `min ${c.getAttribute("min")}`;
        if (v.rangeOverflow) return `max ${c.getAttribute("max")}`;
        if (v.stepMismatch) return "step mismatch";
        if (v.badInput) return "invalid input";
        return "invalid";
      }

      function consequenceFacts(el: Element): string[] {
        const facts: string[] = [];
        const tag = el.tagName;

        if (tag === "A" && el.hasAttribute("href")) {
          const href = el.getAttribute("href") || "";
          try {
            const url = new URL(href, location.href);
            const path = `${url.pathname}${url.search}${url.hash}`;
            if (url.origin === location.origin) facts.push(`→ navigates to ${path}`);
            else facts.push(`→ navigates to ${url.origin}${path}`);
          } catch {
            facts.push(`→ navigates to ${href}`);
          }
        }

        if (isSubmitControl(el)) {
          const asControl = el as unknown as FormControlLike;
          const form = asControl.form || el.closest("form");
          // A submit-typed control with no owning form is a no-op in the
          // browser (nothing to submit), so it gets no consequence line.
          if (form) {
            const controls = Array.from(form.elements) as unknown as FormControlLike[];
            const invalids: string[] = [];
            for (const c of controls) {
              if (!c.willValidate || c.checkValidity()) continue;
              const ref = c.getAttribute("data-fh-ref");
              const label = ref || accessibleName(c);
              invalids.push(`${label} ${shortRuleFor(c)}`);
            }
            if (invalids.length) {
              facts.push(`→ submits form (BLOCKED: ${invalids.length} invalid: ${invalids.join(", ")})`);
            } else {
              facts.push("→ submits form (form currently valid)");
            }
          }
        }

        if (isResetControl(el)) facts.push("→ clears the form");

        const role = (el.getAttribute("role") || "").toLowerCase();
        const nativeType = tag === "INPUT" ? (el.getAttribute("type") || "").toLowerCase() : "";
        const isCheckboxish =
          role === "switch" || role === "checkbox" || role === "radio" || nativeType === "checkbox" || nativeType === "radio";
        if (isCheckboxish) {
          const inputLike = el as HTMLInputElement;
          const checked =
            (tag === "INPUT" && inputLike.checked) ||
            el.getAttribute("aria-checked") === "true" ||
            el.hasAttribute("checked");
          const verb = role === "radio" || nativeType === "radio" ? "selects" : "toggles";
          facts.push(`→ ${verb} (now ${checked ? "checked" : "unchecked"})`);
        }

        if (tag === "SUMMARY" || el.hasAttribute("aria-expanded")) {
          const controlsId = el.getAttribute("aria-controls");
          let target: string | null = null;
          if (controlsId) {
            const node = document.getElementById(controlsId);
            target = node ? accessibleName(node) : controlsId;
          }
          if (!target) target = accessibleName(el);
          facts.push(`→ expands/collapses ${target}`);
        }

        if (tag === "SELECT") {
          const select = el as HTMLSelectElement;
          const opts = Array.from(select.options).map((o) => o.value);
          const shown = opts.slice(0, 8);
          const suffix = opts.length > 8 ? ", …" : "";
          facts.push(`options: ${shown.join(", ")}${suffix}`);
        }

        const hasFrameworkHandler = Array.from(el.attributes).some(
          (a) =>
            a.name === "onclick" ||
            a.name.startsWith("data-action") ||
            a.name.startsWith("ng-click") ||
            a.name.startsWith("@click") ||
            a.name.startsWith("v-on"),
        );
        if (hasFrameworkHandler) facts.push("→ runs script");

        return facts;
      }

      // ---------- main pass ----------

      const lines: string[] = [];
      for (const ref of refs) {
        const el = document.querySelector(`[data-fh-ref="${CSS.escape(ref)}"]`);
        if (!el) continue;

        const { facts: contract, hidden } = contractFacts(el);
        const consequences = consequenceFacts(el);
        const facts = [...contract, ...consequences];
        if (facts.length === 0) continue;

        const prefix = hidden ? "(hidden rule) " : "";
        lines.push(`${ref} · ${prefix}${facts.join(", ")}`);
      }

      return lines;
    }, refsInObservation);

    const capped = lines.slice(0, MAX_ANNOTATION_LINES);
    const text = `xray:\n${capped.join("\n")}`;
    return { text, approxTokens: Math.ceil(text.length / 4), count: capped.length };
  }

  async function preflight(submitRef: string): Promise<Violation[]> {
    return page.evaluate((ref: string): Violation[] => {
      function accessibleName(el: Element): string {
        const ariaLabel = el.getAttribute("aria-label");
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const parts = labelledby
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim())
            .filter((t): t is string => Boolean(t));
          if (parts.length) return parts.join(" ");
        }

        const id = el.getAttribute("id");
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl?.textContent?.trim()) return lbl.textContent.trim();
        }

        const closestLabel = el.closest("label");
        if (closestLabel?.textContent?.trim()) return closestLabel.textContent.trim();

        const placeholder = el.getAttribute("placeholder");
        if (placeholder?.trim()) return placeholder.trim();

        if (el.tagName === "A" || el.tagName === "BUTTON") {
          const txt = el.textContent?.trim();
          if (txt) return txt;
        }

        return el.getAttribute("name") || id || el.tagName.toLowerCase();
      }

      interface FormControlLike extends Element {
        checkValidity(): boolean;
        validity: ValidityState;
        validationMessage: string;
        willValidate: boolean;
        form: HTMLFormElement | null;
      }

      const el = document.querySelector(`[data-fh-ref="${CSS.escape(ref)}"]`);
      if (!el) return [];

      const asControl = el as unknown as FormControlLike;
      const form = asControl.form || el.closest("form");
      if (!form) return [];

      const flags: Array<keyof ValidityState> = [
        "valueMissing",
        "typeMismatch",
        "patternMismatch",
        "tooShort",
        "tooLong",
        "rangeUnderflow",
        "rangeOverflow",
        "stepMismatch",
        "badInput",
      ];

      const violations: Violation[] = [];
      const controls = Array.from(form.elements) as unknown as FormControlLike[];
      for (const c of controls) {
        if (!c.willValidate) continue;
        if (c.checkValidity()) continue;

        let rule = "customError";
        for (const f of flags) {
          if (c.validity[f]) {
            rule = f;
            break;
          }
        }

        violations.push({
          ref: c.getAttribute("data-fh-ref"),
          field: accessibleName(c),
          rule,
          message: c.validationMessage,
        });
      }

      return violations;
    }, submitRef);
  }

  return { annotate, preflight };
}
