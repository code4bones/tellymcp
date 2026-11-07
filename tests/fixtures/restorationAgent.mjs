// A deterministic interactive process, not a provider/network integration.
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { setInterval, clearInterval } from "node:timers";
process.stdin.setRawMode(true);
process.stdin.resume();
let replies = 0;
let ticks = 0;
let input = "";
const decoder = new StringDecoder("utf8");
process.stdout.write(`AGENT:${process.pid}:SHELL:${process.ppid}\r\n`);
const timer = setInterval(() => {
  process.stdout.write(`tick:${++ticks}\r\n`);
}, 30);
process.stdin.on("data", (data) => {
  input += decoder.write(data);
  while (input.length) {
    if (input.startsWith("\x1b[0n")) {
      input = input.slice(4);
      process.stdout.write(`reply:${++replies}\r\n`);
    } else if (input.startsWith("\x1b")) {
      // Retain split DSR responses.
      if ("\x1b[0n".startsWith(input)) return;
      process.stdout.write("UNEXPECTED-RESPONSE\r\n");
      input = "";
    } else {
      const end = input.indexOf("\r");
      if (end < 0) return;
      const command = input.slice(0, end);
      input = input.slice(end + 1);
      if (command === "query") process.stdout.write("\x1b[5n");
      else if (command === "exit") {
        clearInterval(timer);
        process.stdin.pause();
        process.stdout.write("AGENT-DONE\r\n", () => process.exit(0));
      } else process.stdout.write(`echo:${command}\r\n`);
    }
  }
});
