import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";

export function createBus(config, receiveQueue, sendQueue) {
  const client = new ServiceBusClient(config.serviceBusFqdn, new DefaultAzureCredential());
  const sender = client.createSender(sendQueue);
  const receiver = client.createReceiver(receiveQueue, { receiveMode: "peekLock" });
  return { client, sender, receiver };
}

export async function sendMessage(sender, body, messageId, correlationId = messageId) {
  await sender.sendMessages({
    body,
    messageId,
    correlationId,
    contentType: "application/json",
    subject: body.type,
    applicationProperties: { schemaVersion: 1 },
  });
}
