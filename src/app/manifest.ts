import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Jayngol Transport Management System",
    short_name: "Jayngol TMS",
    start_url: "/",
    display: "standalone",
    background_color: "#fbf7ec",
    theme_color: "#1a150c",
    icons: [{ src: "/brand/jayngol-mark.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
