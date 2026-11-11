import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateIpAddress, validateBrowserUrl } from "./browser-service.js";

test("browser accepts only credential-free HTTP and HTTPS URLs", () => {
  assert.equal(validateBrowserUrl("https://example.com/path").href, "https://example.com/path");
  assert.equal(validateBrowserUrl("http://127.0.0.1:3000").hostname, "127.0.0.1");
  assert.throws(() => validateBrowserUrl("file:///etc/passwd"), /http and https/);
  assert.throws(() => validateBrowserUrl("https://user:secret@example.com"), /credential-free/);
  assert.throws(() => validateBrowserUrl("not a url"), /complete http or https/);
  assert.throws(() => validateBrowserUrl(`https://example.com/${"a".repeat(4096)}`), /4096 characters/);
});

test("browser destination filter blocks private and reserved IP ranges", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.10.20", "172.20.0.1",
    "192.168.1.1", "100.64.0.1", "198.18.0.1", "203.0.113.8",
    "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1",
    "2001:db8::1", "::ffff:7f00:1"
  ]) assert.equal(isPrivateIpAddress(address), true, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateIpAddress(address), false, address);
  }
});
