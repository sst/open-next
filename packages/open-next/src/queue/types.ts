export interface QueueMessage {
  MessageDeduplicationId: string;
  MessageBody: {
    host: string;
    url: string;
  };
  MessageGroupId: string;
}

export interface Queue {
  send(message: QueueMessage): Promise<void>;
}
