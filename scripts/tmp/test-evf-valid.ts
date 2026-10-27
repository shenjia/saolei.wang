import { readFileSync } from "fs";
import { evfIsValid } from "../../src/lib/msvalid";

const buf = new Uint8Array(readFileSync("/tmp/347854.evf"));
const r = await evfIsValid(buf, "a8e5f785bad33a02cff261f5e8ae3f67.evf");
if (r === null) {
  console.log("evfIsValid => null（初始化失败或解析异常，按无信号处理）");
} else {
  console.log("verdict:", r.verdict, "(0=通过 1=不通过 3=可疑)");
  console.log("software:", r.software);
  console.log("completed:", r.completed, "| bbbv:", r.bbbv, "| rtime:", r.rtimeSec);
}
