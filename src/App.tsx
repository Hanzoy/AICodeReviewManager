import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiOutlined,
  AppstoreOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloudServerOutlined,
  CodeOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DisconnectOutlined,
  LinkOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined
} from "@ant-design/icons";
import {
  Alert,
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Result,
  Row,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type MenuProps,
  type TableProps
} from "antd";
import type {
  EnrollmentResult,
  GroupWorkspaceData,
  ManagerRuntimeInfo,
  ProjectGroupSummary
} from "../shared/contracts";
import { managerApi } from "./api";
import { commandWithFrontendHostname, frontendHostPort, withFrontendHostname } from "./frontendAddress";
import { useVisiblePolling } from "./useVisiblePolling";
import { GroupWorkspace, type WorkspacePage } from "./GroupWorkspace";

const { Header, Sider, Content } = Layout;
const { Title, Text, Paragraph } = Typography;

type PageKey = "groups" | "nodes" | "settings";
type AppRoute =
  | { kind: "manager" }
  | { kind: "group"; groupKey: string; page: WorkspacePage; projectId?: string; reviewTaskId?: string }
  | { kind: "not-found" };

const workspacePages = new Set<WorkspacePage>(["dashboard", "projects", "reviews", "settings"]);

function currentRoute(): AppRoute {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/" || pathname === "/groups") return { kind: "manager" };
  const match = pathname.match(/^\/groups\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!match) return { kind: "not-found" };
  try {
    const page = (match[2] ?? "dashboard") as WorkspacePage;
    if (!workspacePages.has(page)) return { kind: "not-found" };
    if (match[3] && page !== "projects") return { kind: "not-found" };
    return {
      kind: "group",
      groupKey: decodeURIComponent(match[1]),
      page,
      projectId: match[3] ? decodeURIComponent(match[3]) : undefined,
      reviewTaskId: page === "projects" && match[3]
        ? new URLSearchParams(window.location.search).get("reviewTask")?.trim() || undefined
        : undefined
    };
  } catch {
    return { kind: "not-found" };
  }
}

function groupPath(groupKey: string, page: WorkspacePage, projectId?: string, reviewTaskId?: string) {
  const base = `/groups/${encodeURIComponent(groupKey)}`;
  if (page === "dashboard") return base;
  const pagePath = `${base}/${page}`;
  if (page === "projects" && projectId) {
    const projectPath = `${pagePath}/${encodeURIComponent(projectId)}`;
    return reviewTaskId ? `${projectPath}?reviewTask=${encodeURIComponent(reviewTaskId)}` : projectPath;
  }
  return pagePath;
}

function formatTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function nodeStatus(group: ProjectGroupSummary) {
  if (!group.node) return { label: "等待注册", color: "default", badge: "default" as const };
  if (group.node.status === "online") {
    return { label: "在线", color: "success", badge: "success" as const };
  }
  if (group.node.status === "stopping") {
    return { label: "正在停止", color: "warning", badge: "warning" as const };
  }
  return { label: "离线", color: "error", badge: "error" as const };
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => currentRoute());
  const [page, setPage] = useState<PageKey>("groups");
  const [runtime, setRuntime] = useState<ManagerRuntimeInfo>();
  const [groups, setGroups] = useState<ProjectGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [enrollment, setEnrollment] = useState<EnrollmentResult>();
  const [selectedGroup, setSelectedGroup] = useState<ProjectGroupSummary>();
  const loadInFlight = useRef<Promise<void> | undefined>(undefined);
  const runtimeLoaded = useRef(false);
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const displayedManagerUrl = runtime ? withFrontendHostname(runtime.publicUrl) : undefined;
  const displayedStartCommand = enrollment
    ? commandWithFrontendHostname(enrollment.startCommand)
    : undefined;

  const navigateToManager = useCallback(() => {
    window.history.pushState(null, "", "/");
    setRoute({ kind: "manager" });
  }, []);

  const navigateToGroup = useCallback((group: ProjectGroupSummary, workspacePage: WorkspacePage = "dashboard", projectId?: string, reviewTaskId?: string) => {
    window.history.pushState(null, "", groupPath(group.key, workspacePage, projectId, reviewTaskId));
    setRoute({ kind: "group", groupKey: group.key, page: workspacePage, projectId, reviewTaskId });
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const load = useCallback((quiet = false, refreshRuntime = false) => {
    if (loadInFlight.current) return loadInFlight.current;
    if (!quiet) setLoading(true);
    const operation = (async () => {
      try {
        const shouldLoadRuntime = refreshRuntime || !runtimeLoaded.current;
        const [runtimeResult, groupResult] = await Promise.all([
          shouldLoadRuntime ? managerApi.runtime() : Promise.resolve(undefined),
          managerApi.groups()
        ]);
        if (runtimeResult) {
          runtimeLoaded.current = true;
          setRuntime(runtimeResult);
        }
        setGroups(groupResult);
        setLoadError(undefined);
        setSelectedGroup((current) =>
          current ? groupResult.find((group) => group.id === current.id) : undefined
        );
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "无法连接总管理端");
      } finally {
        setLoading(false);
      }
    })();
    loadInFlight.current = operation;
    void operation.finally(() => {
      if (loadInFlight.current === operation) loadInFlight.current = undefined;
    });
    return operation;
  }, []);

  useEffect(() => {
    void load(false, true);
  }, [load]);

  useVisiblePolling(
    () => load(true),
    15_000,
    { enabled: route.kind === "manager", runImmediately: true }
  );

  const createGroup = async () => {
    const values = await form.validateFields();
    setCreating(true);
    try {
      const result = await managerApi.createGroup(values);
      setEnrollment(result);
      setCreateOpen(false);
      form.resetFields();
      await load(true);
      message.success("项目组已创建，注册码将在 30 分钟后失效");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const rotateEnrollment = async (group: ProjectGroupSummary) => {
    try {
      const result = await managerApi.rotateEnrollment(group.id);
      setEnrollment(result);
      await load(true);
      message.success("已生成新的单次注册码");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "生成失败");
    }
  };

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    message.success(`${label}已复制`);
  };

  const menuItems: MenuProps["items"] = [
    { key: "groups", icon: <TeamOutlined />, label: "项目组" },
    { key: "nodes", icon: <CloudServerOutlined />, label: "节点状态" },
    { type: "divider" },
    { key: "settings", icon: <SettingOutlined />, label: "系统设置" }
  ];

  const columns = useMemo<TableProps<ProjectGroupSummary>["columns"]>(
    () => [
      {
        title: "项目组",
        dataIndex: "name",
        render: (_value, group) => (
          <Space size={12}>
            <Avatar shape="square" className="group-avatar">
              {group.name.slice(0, 1).toUpperCase()}
            </Avatar>
            <div>
              <Button type="link" className="name-link" onClick={() => setSelectedGroup(group)}>
                {group.name}
              </Button>
              <div className="secondary-text">{group.key}</div>
            </div>
          </Space>
        )
      },
      {
        title: "节点状态",
        key: "nodeStatus",
        width: 130,
        render: (_value, group) => {
          const status = nodeStatus(group);
          return <Badge status={status.badge} text={status.label} />;
        }
      },
      {
        title: "节点地址",
        key: "endpoint",
        render: (_value, group) =>
          group.node ? <Text code>{frontendHostPort(group.node.host, group.node.port)}</Text> : <Text type="secondary">—</Text>
      },
      {
        title: "版本",
        key: "version",
        width: 100,
        render: (_value, group) => group.node?.version ?? "—"
      },
      {
        title: "最近心跳",
        key: "heartbeat",
        width: 160,
        render: (_value, group) => formatTime(group.node?.lastHeartbeatAt)
      },
      {
        title: "操作",
        key: "actions",
        width: 220,
        render: (_value, group) => (
          <Space>
            <Button size="small" type="primary" onClick={() => navigateToGroup(group)}>进入</Button>
            <Button size="small" onClick={() => setSelectedGroup(group)}>查看</Button>
            {!group.node || group.node.status !== "online" ? (
              <Button size="small" type="primary" ghost onClick={() => void rotateEnrollment(group)}>
                注册节点
              </Button>
            ) : null}
          </Space>
        )
      }
    ],
    [navigateToGroup]
  );

  if (route.kind === "not-found") {
    return <Result status="404" title="页面不存在" subTitle="请检查访问地址中的项目组标识。" extra={<Button type="primary" onClick={navigateToManager}>返回总管理端</Button>} />;
  }

  if (route.kind === "group") {
    const workspaceGroup = groups.find((group) => group.key.toLowerCase() === route.groupKey.toLowerCase());
    if (loading && groups.length === 0) {
      return <div className="app-content"><Skeleton active paragraph={{ rows: 10 }} /></div>;
    }
    if (loadError) {
      return <Result status="error" title="无法加载项目组" subTitle={loadError} extra={<Button type="primary" onClick={() => void load()}>重新连接</Button>} />;
    }
    if (!workspaceGroup) {
      return <Result status="404" title="项目组不存在" subTitle={`没有找到标识为 ${route.groupKey} 的项目组。`} extra={<Button type="primary" onClick={navigateToManager}>返回总管理端</Button>} />;
    }
    return (
      <GroupWorkspace
        group={workspaceGroup}
        page={route.page}
        projectId={route.projectId}
        reviewTaskId={route.reviewTaskId}
        onBack={navigateToManager}
        onPageChange={(workspacePage) => navigateToGroup(workspaceGroup, workspacePage)}
        onProjectOpen={(projectId, reviewTaskId) => navigateToGroup(workspaceGroup, "projects", projectId, reviewTaskId)}
        onProjectClose={() => navigateToGroup(workspaceGroup, "projects")}
      />
    );
  }

  return (
    <Layout className="app-shell">
      <Sider width={232} breakpoint="lg" collapsedWidth={72} className="app-sider">
        <div className="brand">
          <div className="brand-mark"><CodeOutlined /></div>
          <div className="brand-copy">
            <span>Code Review</span>
            <small>CONTROL CENTER</small>
          </div>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[page]}
          items={menuItems}
          onClick={({ key }) => setPage(key as PageKey)}
        />
        <div className="sider-footer">
          <SafetyCertificateOutlined />
          <span>本地隔离模式</span>
        </div>
      </Sider>

      <Layout>
        <Header className="app-header">
          <div>
            <Text className="eyebrow">总管理端</Text>
            <Title level={4}>AI Code Review 控制中心</Title>
          </div>
          <Space size={16}>
            <Badge status={loadError ? "error" : "success"} text={loadError ? "连接异常" : "服务正常"} />
            <Tooltip title="刷新">
              <Button icon={<ReloadOutlined />} onClick={() => void load(false, true)} loading={loading} />
            </Tooltip>
          </Space>
        </Header>

        <Content className="app-content">
          {loadError ? (
            <Alert
              type="error"
              showIcon
              message="无法连接总管理端"
              description={`${loadError}。请确认 Node 管理服务已在 7000 端口启动。`}
              action={<Button onClick={() => void load()}>重新连接</Button>}
            />
          ) : null}

          {page === "groups" ? (
            <>
              <section className="page-heading">
                <div>
                  <Title level={2}>项目组</Title>
                  <Paragraph type="secondary">
                    每个项目组由独立 Node 进程承载，配置、仓库和 Review 数据彼此隔离。
                  </Paragraph>
                </div>
                <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  创建项目组
                </Button>
              </section>

              <Card className="registry-card" bordered={false}>
                <Flex justify="space-between" align="center" gap={24} wrap>
                  <Space size={16}>
                    <div className="registry-icon"><ApiOutlined /></div>
                    <div>
                      <Text strong>节点注册地址</Text>
                      <div className="registry-url">
                        <Text code>{displayedManagerUrl ?? "正在读取…"}</Text>
                        {displayedManagerUrl ? (
                          <Button
                            type="text"
                            icon={<CopyOutlined />}
                            onClick={() => void copy(displayedManagerUrl, "管理端地址")}
                          />
                        ) : null}
                      </div>
                    </div>
                  </Space>
                  <Space split={<span className="split-dot">•</span>}>
                    <Text type="secondary">监听端口 {runtime?.port ?? "—"}</Text>
                    <Text type="secondary">心跳超时 {runtime?.heartbeatTimeoutSeconds ?? "—"} 秒</Text>
                  </Space>
                </Flex>
              </Card>

              <Card className="content-card" bordered={false}>
                {loading && groups.length === 0 ? (
                  <Skeleton active paragraph={{ rows: 6 }} />
                ) : groups.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="还没有项目组"
                  >
                    <Button type="primary" onClick={() => setCreateOpen(true)}>创建第一个项目组</Button>
                  </Empty>
                ) : (
                  <Table
                    rowKey="id"
                    columns={columns}
                    dataSource={groups}
                    pagination={false}
                    scroll={{ x: 900 }}
                  />
                )}
              </Card>
            </>
          ) : null}

          {page === "nodes" ? (
            <NodePage groups={groups} loading={loading} onEnroll={(group) => void rotateEnrollment(group)} />
          ) : null}

          {page === "settings" ? <SystemPage runtime={runtime} /> : null}
        </Content>
      </Layout>

      <Modal
        title="创建项目组"
        open={createOpen}
        okText="创建并生成注册码"
        cancelText="取消"
        confirmLoading={creating}
        onOk={() => void createGroup()}
        onCancel={() => setCreateOpen(false)}
      >
        <Paragraph type="secondary">项目组创建后会生成一个 30 分钟有效的单次注册代码。</Paragraph>
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item name="name" label="项目组名称" rules={[{ required: true, min: 2 }]}>
            <Input placeholder="G001客户端" autoFocus />
          </Form.Item>
          <Form.Item
            name="key"
            label="项目组标识"
            rules={[
              { required: true },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9-]*$/, message: "只能使用字母、数字和连字符" }
            ]}
          >
            <Input placeholder="G001-Client" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="说明该项目组负责的系统或团队" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="启动项目组节点"
        open={Boolean(enrollment)}
        width={720}
        footer={<Button type="primary" onClick={() => setEnrollment(undefined)}>我已保存</Button>}
        onCancel={() => setEnrollment(undefined)}
      >
        {enrollment ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Alert
              type="warning"
              showIcon
              message="注册代码只在这里完整显示一次"
              description={`请在 ${formatTime(enrollment.expiresAt)} 前启动节点。重新生成后，旧代码会立即失效。`}
            />
            <div>
              <Text strong>启动命令</Text>
              <div className="command-box">
                <code>{displayedStartCommand}</code>
                <Button icon={<CopyOutlined />} onClick={() => void copy(displayedStartCommand ?? "", "启动命令")}>
                  复制
                </Button>
              </div>
            </div>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="项目组">{enrollment.group.name}</Descriptions.Item>
              <Descriptions.Item label="项目组 ID"><Text copyable code>{enrollment.group.id}</Text></Descriptions.Item>
              <Descriptions.Item label="注册代码"><Text copyable code>{enrollment.enrollmentToken}</Text></Descriptions.Item>
            </Descriptions>
          </Space>
        ) : null}
      </Modal>

      <GroupDrawer
        group={selectedGroup}
        onClose={() => setSelectedGroup(undefined)}
        onEnroll={(group) => void rotateEnrollment(group)}
        onOpen={(group) => {
          setSelectedGroup(undefined);
          navigateToGroup(group);
        }}
      />
    </Layout>
  );
}

function NodePage({
  groups,
  loading,
  onEnroll
}: {
  groups: ProjectGroupSummary[];
  loading: boolean;
  onEnroll: (group: ProjectGroupSummary) => void;
}) {
  return (
    <>
      <section className="page-heading">
        <div>
          <Title level={2}>节点状态</Title>
          <Paragraph type="secondary">查看每个项目组进程的端口、版本和心跳状态。</Paragraph>
        </div>
      </section>
      {loading && groups.length === 0 ? <Skeleton active /> : null}
      {!loading && groups.length === 0 ? <Empty description="还没有项目组节点" /> : null}
      <Row gutter={[18, 18]}>
        {groups.map((group) => {
          const status = nodeStatus(group);
          return (
            <Col xs={24} xl={12} key={group.id}>
              <Card className="node-card" bordered={false}>
                <Flex justify="space-between" align="flex-start">
                  <Space size={12}>
                    <Avatar size={44} icon={group.node ? <CloudServerOutlined /> : <DisconnectOutlined />} />
                    <div>
                      <Text strong>{group.name}</Text>
                      <div className="secondary-text">{group.key}</div>
                    </div>
                  </Space>
                  <Tag color={status.color}>{status.label}</Tag>
                </Flex>
                <Descriptions size="small" column={1} className="node-descriptions">
                  <Descriptions.Item label="节点地址">
                    {group.node ? frontendHostPort(group.node.host, group.node.port) : "尚未注册"}
                  </Descriptions.Item>
                  <Descriptions.Item label="节点版本">{group.node?.version ?? "—"}</Descriptions.Item>
                  <Descriptions.Item label="最近心跳">{formatTime(group.node?.lastHeartbeatAt)}</Descriptions.Item>
                  <Descriptions.Item label="能力">
                    {group.node?.capabilities.map((item) => <Tag key={item}>{item}</Tag>) ?? "—"}
                  </Descriptions.Item>
                </Descriptions>
                {!group.node || group.node.status !== "online" ? (
                  <Button block type="dashed" icon={<LinkOutlined />} onClick={() => onEnroll(group)}>
                    生成节点注册命令
                  </Button>
                ) : null}
              </Card>
            </Col>
          );
        })}
      </Row>
    </>
  );
}

function SystemPage({ runtime }: { runtime?: ManagerRuntimeInfo }) {
  return (
    <>
      <section className="page-heading">
        <div>
          <Title level={2}>系统设置</Title>
          <Paragraph type="secondary">当前版本使用本地文件存储，配置和运行数据不会写入数据库。</Paragraph>
        </div>
      </section>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={14}>
          <Card title="总管理端" bordered={false} className="content-card">
            <Descriptions column={1} labelStyle={{ width: 140 }}>
              <Descriptions.Item label="服务名称">{runtime?.name ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="版本">{runtime?.version ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="公开地址"><Text code>{runtime ? withFrontendHostname(runtime.publicUrl) : "—"}</Text></Descriptions.Item>
              <Descriptions.Item label="节点注册接口"><Text code>{runtime ? withFrontendHostname(runtime.registrationUrl) : "—"}</Text></Descriptions.Item>
              <Descriptions.Item label="启动时间">{formatTime(runtime?.startedAt)}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="存储边界" bordered={false} className="content-card">
            <Space direction="vertical" size={14}>
              <Feature icon={<DatabaseOutlined />} title="管理端数据" text="data/manager" />
              <Feature icon={<TeamOutlined />} title="项目组数据" text="data/group-nodes/{groupId}" />
              <Feature icon={<SafetyCertificateOutlined />} title="隔离方式" text="独立进程 + 独立目录" />
            </Space>
          </Card>
        </Col>
      </Row>
    </>
  );
}

function Feature({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <Space size={12}>
      <span className="feature-icon">{icon}</span>
      <div>
        <Text strong>{title}</Text>
        <div className="secondary-text">{text}</div>
      </div>
    </Space>
  );
}

function GroupDrawer({
  group,
  onClose,
  onEnroll,
  onOpen
}: {
  group?: ProjectGroupSummary;
  onClose: () => void;
  onEnroll: (group: ProjectGroupSummary) => void;
  onOpen: (group: ProjectGroupSummary) => void;
}) {
  const [workspace, setWorkspace] = useState<GroupWorkspaceData>();
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const groupId = group?.id;
  const nodeOnline = group?.node?.status === "online";

  useEffect(() => {
    setWorkspace(undefined);
    setWorkspaceError(undefined);
    if (!groupId || !nodeOnline) {
      setWorkspaceLoading(false);
      return;
    }
    let active = true;
    setWorkspaceLoading(true);
    void managerApi.workspace(groupId)
      .then((result) => {
        if (active) setWorkspace(result);
      })
      .catch((error: unknown) => {
        if (active) setWorkspaceError(error instanceof Error ? error.message : "项目组配置读取失败");
      })
      .finally(() => {
        if (active) setWorkspaceLoading(false);
      });
    return () => { active = false; };
  }, [groupId, nodeOnline]);

  if (!group) return null;
  const status = nodeStatus(group);
  const unavailableState: CapabilityState = workspaceLoading
    ? "loading"
    : workspaceError || !nodeOnline
      ? "unavailable"
      : "unconfigured";
  const gitlabState: CapabilityState = workspace
    ? workspace.config.gitlab.tokenConfigured && Boolean(workspace.config.gitlab.baseUrl)
      ? "ready"
      : "unconfigured"
    : unavailableState;
  const aiState: CapabilityState = workspace
    ? workspace.config.ai.apiKeyConfigured && Boolean(workspace.config.ai.model && workspace.config.ai.reviewPrompt)
      ? "ready"
      : "unconfigured"
    : unavailableState;
  const feishuState: CapabilityState = workspace
    ? !workspace.config.feishu.enabled
      ? "disabled"
      : workspace.config.feishu.webhookConfigured
        ? "ready"
        : "unconfigured"
    : unavailableState;
  return (
    <Drawer title="项目组详情" open width={560} onClose={onClose}>
      <Space direction="vertical" size={20} style={{ width: "100%" }}>
        <Flex justify="space-between" align="center">
          <Space size={12}>
            <Avatar size={48} shape="square" className="group-avatar">{group.name.slice(0, 1)}</Avatar>
            <div>
              <Title level={4} style={{ margin: 0 }}>{group.name}</Title>
              <Text type="secondary">{group.key}</Text>
            </div>
          </Space>
          <Tag color={status.color}>{status.label}</Tag>
        </Flex>

        <Paragraph type="secondary">{group.description || "暂无项目组描述"}</Paragraph>

        <Card size="small" title="节点连接">
          {group.node ? (
            <Descriptions column={1} size="small">
              <Descriptions.Item label="节点 ID"><Text code>{group.node.id.slice(0, 12)}…</Text></Descriptions.Item>
              <Descriptions.Item label="节点地址"><Text code>{withFrontendHostname(group.node.baseUrl)}</Text></Descriptions.Item>
              <Descriptions.Item label="版本">{group.node.version}</Descriptions.Item>
              <Descriptions.Item label="最近心跳">{formatTime(group.node.lastHeartbeatAt)}</Descriptions.Item>
            </Descriptions>
          ) : (
            <Result
              icon={<ClockCircleOutlined />}
              title="等待节点注册"
              subTitle="生成单次注册命令，并在需要承载该项目组的机器上运行。"
              extra={<Button type="primary" onClick={() => onEnroll(group)}>生成注册命令</Button>}
            />
          )}
        </Card>

        <Card size="small" title="项目组能力">
          <Row gutter={[12, 12]}>
            <Col span={8}><Capability icon={<CloudServerOutlined />} title="GitLab" state={gitlabState} /></Col>
            <Col span={8}><Capability icon={<RobotOutlined />} title="DeepSeek" state={aiState} /></Col>
            <Col span={8}><Capability icon={<AppstoreOutlined />} title="飞书" state={feishuState} /></Col>
          </Row>
        </Card>

        <Alert
          type={workspaceError ? "warning" : "info"}
          showIcon
          message={workspaceError ? "项目组配置暂时无法读取" : "状态实时来自项目组节点"}
          description={workspaceError ?? (workspace
            ? `配置版本 v${workspace.config.revision}；当前有 ${workspace.stats.projectCount} 个项目、${workspace.stats.queuedReviewCount} 个排队任务。密钥仍只保存在项目组节点。`
            : "GitLab、DeepSeek、飞书密钥及 Review 数据不会保存到总管理端。节点在线后会在这里读取非敏感配置状态。")}
        />
        <Button type="primary" size="large" block onClick={() => onOpen(group)}>
          进入项目组工作台
        </Button>
      </Space>
    </Drawer>
  );
}

type CapabilityState = "loading" | "ready" | "unconfigured" | "disabled" | "unavailable";

function Capability({ icon, title, state }: { icon: React.ReactNode; title: string; state: CapabilityState }) {
  const statusText = {
    loading: "读取中",
    ready: "已配置",
    unconfigured: "待配置",
    disabled: "已关闭",
    unavailable: "节点不可用"
  }[state];
  return (
    <div className={`capability ${state}`}>
      <span>{icon}</span>
      <Text>{title}</Text>
      {state === "ready" ? <Space size={4} className="capability-ready"><CheckCircleFilled /><small>{statusText}</small></Space> : <small>{statusText}</small>}
    </div>
  );
}
