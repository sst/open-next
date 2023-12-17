import { createServer } from "node:http";

import { StreamCreator } from "http/index.js";
import type { WrapperHandler } from "types/open-next";

import { debug, error } from "../adapters/logger";

const wrapper: WrapperHandler = async (handler, converter) => {
  const server = createServer(async (req, res) => {
    const internalEvent = await converter.convertFrom(req);
    const _res: StreamCreator = {
      writeHeaders: (prelude) => {
        res.writeHead(prelude.statusCode, prelude.headers);
        res.uncork();
        return res;
      },
      onFinish: () => {
        // Is it necessary to do something here?
      },
    };

    await handler(internalEvent, _res);
  });

  await new Promise<void>((resolve) => {
    server.on("listening", () => {
      const cleanup = (code: number) => {
        debug(`Closing server`);
        server.close(() => {
          debug(`Server closed`);
          process.exit(code);
        });
      };
      console.log(`Listening on port ${process.env.PORT ?? "3000"}`);
      debug(`Open Next version: ${process.env.OPEN_NEXT_VERSION}`);

      process.on("exit", (code) => cleanup(code));

      process.on("SIGINT", () => cleanup(0));
      process.on("SIGTERM", () => cleanup(0));

      resolve();
    });

    server.listen(parseInt(process.env.PORT ?? "3000", 10));
  });

  server.on("error", (err) => {
    error(err);
  });

  return () => {
    server.close();
  };
};

export default {
  wrapper,
  name: "node",
  supportStreaming: true,
};
