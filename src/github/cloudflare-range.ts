import { connect } from "cloudflare:sockets";
import { createTlsRangeRequest } from "./range-http";

export const requestRangeOverTls = createTlsRangeRequest(connect);
