import { handleBloomie } from "../server/bloomie.mjs";

export default {
  fetch(request) {
    const clientIp = request.headers.get("x-forwarded-for")?.trim() ?? "";
    return handleBloomie(request, clientIp);
  },
};
