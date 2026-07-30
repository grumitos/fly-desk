import { after, before } from "node:test";
import {
  startDesktopTestHarness,
  stopDesktopTestHarness,
} from "./helpers/ui.ts";
import "./ui/search-shell.playwright.ts";
import "./ui/autocomplete.playwright.ts";
import "./ui/sharing.playwright.ts";
import "./ui/results.playwright.ts";
import "./ui/filters.playwright.ts";
import "./ui/flexible.playwright.ts";
import "./ui/workspace.playwright.ts";
import "./ui/responsive-smoke.playwright.ts";

before(startDesktopTestHarness);
after(stopDesktopTestHarness);
