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
  loadPublicAssets,
  loadRoutesManifest,
} from "./util.js";

export const NEXT_DIR = path.join(__dirname, ".next");
export const OPEN_NEXT_DIR = path.join(__dirname, ".open-next");

debug({ NEXT_DIR, OPEN_NEXT_DIR });

//TODO: inject these values at build time
export const NextConfig = loadConfig(NEXT_DIR);
export const BuildId = loadBuildId(NEXT_DIR);
export const HtmlPages = loadHtmlPages(NEXT_DIR);
export const PublicAssets = loadPublicAssets(OPEN_NEXT_DIR);
export const RoutesManifest = loadRoutesManifest(NEXT_DIR);
export const ConfigHeaders = loadConfigHeaders(NEXT_DIR);
export const PrerenderManifest = loadPrerenderManifest(NEXT_DIR);
export const AppPathsManifestKeys = loadAppPathsManifestKeys(NEXT_DIR);
export const MiddlewareManifest = loadMiddlewareManifest(NEXT_DIR);
