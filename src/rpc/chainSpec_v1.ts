import { respond, type RpcMethod } from "./rpc_utils";

export const chainSpec_v1_chainName: RpcMethod = async (
  con,
  req,
  { source }
) => {
  con.send(respond(req, (await source.getChainSpecData()).name));
};

export const chainSpec_v1_genesisHash: RpcMethod = async (
  con,
  req,
  { source }
) => {
  con.send(respond(req, (await source.getChainSpecData()).genesisHash));
};

export const chainSpec_v1_properties: RpcMethod = async (
  con,
  req,
  { source }
) => {
  con.send(respond(req, (await source.getChainSpecData()).properties));
};
