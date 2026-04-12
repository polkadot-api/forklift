import { Binary, createClient, type HexString } from "polkadot-api";
import { createWsClient } from "polkadot-api/ws";
import { attachRelay, attachSibling, consumeDmp } from "../xcm";
import { errorResponse, getParams, respond, type RpcMethod } from "./rpc_utils";

/*** Para -> Relay ***/

/**
 * Attaches the current forklift as a parachain to a forklift relay chain.
 */
export const forklift_xcm_attach_relay: RpcMethod<{ url: string }> = async (
  con,
  req,
  { chain, xcm, provider }
) => {
  try {
    const { url } = getParams(req, ["url"]);

    const relayClient = createWsClient(url);
    const parachainClient = createClient(provider);
    await Promise.race([
      await attachRelay(relayClient, parachainClient, chain, xcm),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timed out")), 10_000)
      ),
    ]);

    con.send(respond(req, null));
  } catch (ex: any) {
    console.error(ex);
    con.send(
      errorResponse(req, {
        code: -1,
        message: ex.message,
      })
    );
  }
};

/**
 * Attaches the current forklift as a sibling parachain to a another parachain (for HRMP).
 */
export const forklift_xcm_attach_sibling: RpcMethod<{ url: string }> = async (
  con,
  req,
  { chain, xcm, provider }
) => {
  try {
    const { url } = getParams(req, ["url"]);

    const siblingClient = createWsClient(url);
    const selfClient = createClient(provider);
    await Promise.race([
      attachSibling(siblingClient, selfClient, chain, xcm),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("Timed out")), 10_000)
      ),
    ]);

    con.send(respond(req, null));
  } catch (ex: any) {
    console.error(ex);
    con.send(
      errorResponse(req, {
        code: -1,
        message: ex.message,
      })
    );
  }
};

/**
 * Consumes the DMP XCM messages for that parachain at a specific block
 *
 * This is needed because it can't be done simply with dev_setStorage, as new
 * blocks would not get the DMP entry reset.
 */
export const forklift_xcm_consume_dmp: RpcMethod<{
  hash: HexString;
  paraId: number;
}> = async (con, req, { chain }) => {
  const { hash, paraId } = getParams(req, ["hash", "paraId"]);

  try {
    await consumeDmp(chain, hash, paraId);
    con.send(respond(req, null));
  } catch (ex: any) {
    console.error("forklift_xcm_consume_dmp", ex);

    con.send(
      errorResponse(req, {
        code: -1,
        message: ex.message,
      })
    );
  }
};

/**
 * Pushes HRMP XCM messages into the parachain's ingress queue from a sibling.
 */
export const forklift_xcm_push_hrmp: RpcMethod<{
  senderId: number;
  messages: HexString[];
}> = async (con, req, { xcm }) => {
  const { senderId, messages } = getParams(req, ["senderId", "messages"]);

  try {
    xcm.pushHrmp(senderId, messages.map(Binary.fromHex));
    con.send(respond(req, null));
  } catch (ex: any) {
    console.error("forklift_xcm_push_hrmp", ex);
    con.send(errorResponse(req, { code: -1, message: ex.message }));
  }
};

/**
 * Registers an open outbound HRMP channel from this chain to a recipient parachain.
 * Subsequent blocks will include this channel in the relay chain proof so the runtime
 * allows sending XCM messages to the recipient.
 */
export const forklift_xcm_open_hrmp_channel: RpcMethod<{
  recipientId: number;
}> = async (con, req, { chain }) => {
  const { recipientId } = getParams(req, ["recipientId"]);
  chain.openHrmpChannel(recipientId);
  con.send(respond(req, null));
};

/**
 * Pushes UMP XCM messages into the relay dispatch queue at a specific block.
 */
export const forklift_xcm_push_ump: RpcMethod<{
  paraId: number;
  messages: HexString[];
}> = async (con, req, { xcm }) => {
  const { paraId, messages } = getParams(req, ["paraId", "messages"]);

  try {
    xcm.pushUmp(paraId, messages.map(Binary.fromHex));
    con.send(respond(req, null));
  } catch (ex: any) {
    console.error("forklift_xcm_push_ump", ex);

    con.send(
      errorResponse(req, {
        code: -1,
        message: ex.message,
      })
    );
  }
};
