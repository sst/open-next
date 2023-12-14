import { readFile } from "node:fs/promises";

import { Plugin } from "esbuild";

import logger from "../logger.js";

export interface IPluginSettings {
  target: RegExp;
  replacements?: string[];
  deletes?: string[];
  name?: string;
}

const overridePattern = /\/\/#override (\w+)\n([\s\S]*?)\n\/\/#endOverride/gm;
const importPattern = /\/\/#import([\s\S]*?)\n\/\/#endImport/gm;

/**
 *
 * openNextPlugin({
 *   target: /plugins\/default\.js/g,
 *   replacements: [require.resolve("./plugins/default.js")],
 *   deletes: ["id1"],
 * })
 *
 * To inject arbritary code by using (import at top of file):
 *
 * //#import
 *
 * import data from 'data'
 * const datum = data.datum
 *
 * //#endImport
 *
 * To replace code:
 *
 * //#override id1
 *
 * export function overrideMe() {
 *    // I will replace the "id1" block in the target file
 * }
 *
 * //#endOverride
 *
 *
 * @param opts.target - the target file to replace
 * @param opts.replacements - list of files used to replace the imports/overrides in the target
 *                          - the path is absolute
 * @param opts.deletes - list of ids to delete from the target
 * @returns
 */
export function openNextReplacementPlugin({
  target,
  replacements,
  deletes,
  name,
}: IPluginSettings): Plugin {
  return {
    name: name ?? "opennext",
    setup(build) {
      build.onLoad({ filter: target }, async (args) => {
        let contents = await readFile(args.path, "utf-8");

        await Promise.all([
          ...(deletes ?? []).map(async (id) => {
            const pattern = new RegExp(
              `\/\/#override (${id})\n([\\s\\S]*?)\/\/#endOverride`,
            );
            logger.debug(
              `Open-next plugin ${name} -- Deleting override for ${id}`,
            );
            contents = contents.replace(pattern, "");
          }),
          ...(replacements ?? []).map(async (fp) => {
            const p = fp;
            const replacementFile = await readFile(p, "utf-8");
            const matches = replacementFile.matchAll(overridePattern);

            const importMatch = replacementFile.match(importPattern);
            const addedImport = importMatch ? importMatch[0] : "";

            contents = `${addedImport}\n${contents}`;

            for (const match of matches) {
              const replacement = match[2];
              const id = match[1];
              const pattern = new RegExp(
                `\/\/#override (${id})\n([\\s\\S]*?)\/\/#endOverride`,
                "g",
              );
              logger.debug(
                `Open-next plugin ${name} -- Applying override for ${id} from ${fp}`,
              );
              contents = contents.replace(pattern, replacement);
            }
          }),
        ]);

        return {
          contents,
        };
      });
    },
  };
}
