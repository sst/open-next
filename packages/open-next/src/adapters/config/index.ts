import path from "path";

import { debug } from "../logger";
import {
  loadAppPathsManifestKeys,
  loadBuildId,
  loadConfig,
  loadConfigHeaders,
  loadHtmlPages,
  loadMiddlewareManifest,
  loadPrerenderManifest,
  // loadPublicAssets,
  loadRoutesManifest,
} from "./util.js";

export const NEXT_DIR = path.join(__dirname, ".next");
export const OPEN_NEXT_DIR = path.join(__dirname, ".open-next");

debug({ NEXT_DIR, OPEN_NEXT_DIR });

//TODO: inject these values at build time
export const NextConfig = /* @__PURE__ */ loadConfig(NEXT_DIR);
export const BuildId = /* @__PURE__ */ loadBuildId(NEXT_DIR);
export const HtmlPages = /* @__PURE__ */ loadHtmlPages(NEXT_DIR);
// export const PublicAssets = loadPublicAssets(OPEN_NEXT_DIR);
export const RoutesManifest = /* @__PURE__ */ loadRoutesManifest(NEXT_DIR);
export const ConfigHeaders = /* @__PURE__ */ loadConfigHeaders(NEXT_DIR);
export const PrerenderManifest =
  /* @__PURE__ */ loadPrerenderManifest(NEXT_DIR);
export const AppPathsManifestKeys =
  /* @__PURE__ */ loadAppPathsManifestKeys(NEXT_DIR);
export const MiddlewareManifest =
  /* @__PURE__ */ loadMiddlewareManifest(NEXT_DIR);
