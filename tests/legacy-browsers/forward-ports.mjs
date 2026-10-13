// Docker Desktop for Mac does not share the Mac's loopback with
// --network=host. run.mjs then starts this inside the container: each given
// 127.0.0.1 port is relayed to the same port on host.docker.internal, so the
// browser and the fixture's absolute media URLs keep using 127.0.0.1.
import net from "node:net";
import process from "node:process";

for (const port of process.argv.slice(2).map(Number))
  net
    .createServer((client) => {
      const upstream = net.connect(port, "host.docker.internal");
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.pipe(upstream).pipe(client);
    })
    .listen(port, "127.0.0.1");
