import { describe, expect, it } from "vite-plus/test";

import { publicImageUrl } from "./remote-image";

describe("public image URLs", () => {
  it("accepts public http and https hostnames", () => {
    expect(publicImageUrl("https://cdn.example.com/mark.png?v=1")).toBe(
      "https://cdn.example.com/mark.png?v=1",
    );
    expect(publicImageUrl("http://images.example.com/a.jpg#fragment")).toBe(
      "http://images.example.com/a.jpg",
    );
  });

  it("rejects embedded, credentialed, relative, and private targets", () => {
    for (const value of [
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "/mark.png",
      "https://user:pass@cdn.example.com/a.png",
      "https://localhost/a.png",
      "https://app.localhost/a.png",
      "https://printer.local/a.png",
      "https://files.internal/a.png",
      "http://127.0.0.1/secret.png",
      "http://10.1.2.3/a.png",
      "http://192.168.0.1/a.png",
      "https://8.8.8.8/image.png",
      "http://[::1]/a.png",
      "http://[2606:4700:4700::1111]/image.png",
    ])
      expect(publicImageUrl(value), value).toBeUndefined();
  });
});
