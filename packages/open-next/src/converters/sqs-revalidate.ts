import { SQSEvent } from "aws-lambda";
import { Converter } from "types/open-next";

import { RevalidateEvent } from "../adapters/revalidate";

const converter: Converter<RevalidateEvent, { type: "revalidate" }> = {
  convertFrom(event: SQSEvent) {
    const records = event.Records.map((record) => {
      const { host, url } = JSON.parse(record.body);
      return { host, url };
    });
    return Promise.resolve({
      type: "revalidate",
      records,
    });
  },
  convertTo() {
    return Promise.resolve({
      type: "revalidate",
    });
  },
};

export default converter;
