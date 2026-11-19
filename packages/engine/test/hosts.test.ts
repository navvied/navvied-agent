import { describe, expect, test } from "bun:test";
import { isPrivateHost } from "../src/index.ts";

/** What a URL makes of an address, as the tools hand it over. */
const asUrl = (address: string): string => new URL(address).hostname;

describe("addresses an agent may not reach", () => {
  test("this computer and the local network, in every ordinary form", () => {
    for (const h of ["localhost", "LOCALHOST", "localhost.", "a.localhost", "printer.local", "db.internal", "metadata.google.internal", "host.localdomain", "router.home.arpa",
      "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
      "::1", "::", "[::1]", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1"]) expect(isPrivateHost(h), h).toBe(true);
  });

  test("the reserved and documentation ranges, and everything from 224 up", () => {
    for (const h of ["192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "2001:db8::1", "100::1"]) expect(isPrivateHost(h), h).toBe(true);
  });

  test("an IPv4 address written as an IPv6 one is the IPv4 address: mapped, compatible, NAT64 and 6to4", () => {
    for (const h of ["::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:127.0.0.1]", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:ffff:7f00:0001", "::FFFF:7F00:1",
      "::ffff:10.1.2.3", "::ffff:a01:203", "::ffff:192.168.1.1", "::ffff:169.254.169.254", "::ffff:0.0.0.0", "::127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "2002:7f00:1::1", "2002:a00:1::", "2002:c0a8:101::1"]) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1"]) expect(isPrivateHost(h), h).toBe(false);
  });

  test("an IPv4 address written in the other ways a URL accepts is the IPv4 address", () => {
    for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0x7f.1/", "http://127.1/", "http://017700000001/", "http://0177.0.0.1/", "http://10.1/", "http://0xa9fea9fe/", "http://127.0.0.1./", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[0:0:0:0:0:ffff:127.0.0.1]/"]) {
      expect(isPrivateHost(asUrl(url)), url).toBe(true);
      expect(isPrivateHost(new URL(url).host.replace(/:\d+$/, "")), url).toBe(true);
    }
  });

  test("addresses that are not private stay open", () => {
    for (const h of ["example.com", "localhost.example.com", "notlocal.com", "internal.example.org", "8.8.8.8", "93.184.216.34", "172.32.0.1", "172.15.0.1", "100.128.0.1", "100.63.255.255", "169.255.0.1", "192.169.0.1", "223.255.255.255",
      "2606:4700::1111", "2001:4860:4860::8888", "2a00:1450::1", "[2606:4700::1111]"]) expect(isPrivateHost(h), h).toBe(false);
  });

  test("text that is not an address and looks like one is refused rather than let through", () => {
    for (const h of ["::g", "1::2::3", "::ffff:999.1.1.1", "1:2:3:4:5:6:7:8:9", "1:2:3"]) expect(isPrivateHost(h), h).toBe(true);
  });
});
