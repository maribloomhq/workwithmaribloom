import { handleBloomie } from "../../server/bloomie.mjs";

export default function bloomie(request, context) {
  return handleBloomie(request, context.ip);
}

export const config = { path: "/api/bloomie" };
