import basicSsl from "@vitejs/plugin-basic-ssl";
import tailwindcss from "@tailwindcss/vite";

export default {
  plugins: [basicSsl(), tailwindcss()],
};
