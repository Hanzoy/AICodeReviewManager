import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#5b7cfa",
          colorInfo: "#5b7cfa",
          colorSuccess: "#1aa981",
          borderRadius: 10,
          fontFamily:
            "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        },
        components: {
          Layout: { siderBg: "#0b1220", headerBg: "#ffffff" },
          Menu: {
            darkItemBg: "#0b1220",
            darkItemSelectedBg: "#233459",
            darkItemHoverBg: "#17233b"
          },
          Card: { headerFontSize: 15 }
        }
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>
);
