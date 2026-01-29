#!/bin/bash
# Clawdbot WeCom 插件安装/更新脚本
# 用法: curl -sSL https://raw.githubusercontent.com/DouDOU-start/clawdbot-wechat/master/install.sh | bash

set -e

INSTALL_DIR="${CLAWDBOT_WECOM_DIR:-$HOME/clawdbot-wechat}"
REPO_URL="https://github.com/DouDOU-start/clawdbot-wechat.git"
CONFIG_FILE="$HOME/.clawdbot/clawdbot.json"
BIN_DIR="$HOME/.local/bin"
BIN_NAME="clawdbot-wecom"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_banner() {
    echo ""
    echo -e "${BLUE}========================================"
    echo "  Clawdbot WeCom 插件安装脚本"
    echo -e "========================================${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}! $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${BLUE}→ $1${NC}"
}

# 检查命令是否存在
check_command() {
    if ! command -v "$1" &> /dev/null; then
        print_error "$1 未安装，请先安装 $1"
        exit 1
    fi
}

# 读取用户输入（带默认值，支持管道模式）
read_input() {
    local prompt="$1"
    local default="$2"
    local result

    if [ -n "$default" ]; then
        printf "%s [%s]: " "$prompt" "$default" >&2
        read result < /dev/tty
        echo "${result:-$default}"
    else
        printf "%s: " "$prompt" >&2
        read result < /dev/tty
        echo "$result"
    fi
}

# 读取密码输入（不显示，支持管道模式）
read_secret() {
    local prompt="$1"
    local result

    printf "%s: " "$prompt" >&2
    read -s result < /dev/tty
    echo "" >&2
    echo "$result"
}

# 读取确认输入（支持管道模式）
read_confirm() {
    local prompt="$1"
    local default="$2"
    local result

    printf "%s [%s]: " "$prompt" "$default" >&2
    read result < /dev/tty
    echo "$result"
}

# 配置向导
run_config_wizard() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  企业微信配置向导${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
    echo "请在企业微信管理后台获取以下信息："
    echo "  1. 安全与管理 → 管理工具 → 创建机器人（API模式）"
    echo "  2. 获取 Token 和 EncodingAESKey"
    echo ""

    # 基础配置
    local webhook_path=$(read_input "Webhook 路径" "/wecom")
    local token=$(read_input "Token（企业微信后台生成）" "")
    local encoding_aes_key=$(read_input "EncodingAESKey（企业微信后台生成）" "")

    if [ -z "$token" ] || [ -z "$encoding_aes_key" ]; then
        print_error "Token 和 EncodingAESKey 为必填项"
        return 1
    fi

    # 可选配置
    echo ""
    echo "以下为可选配置（直接回车跳过）："
    local receive_id=$(read_input "ReceiveId（通常留空）" "")
    local welcome_text=$(read_input "欢迎语（用户首次进入时显示）" "")

    # 出站 API 配置
    echo ""
    local config_outbound=$(read_confirm "是否配置出站 API（用于主动发送消息）？[y/N]" "N")
    local corp_id=""
    local agent_id=""
    local secret=""

    if [[ "$config_outbound" =~ ^[Yy]$ ]]; then
        echo ""
        echo "请在企业微信管理后台获取以下信息："
        echo "  - 我的企业 → 企业信息 → 企业ID"
        echo "  - 应用管理 → 选择机器人应用 → AgentId 和 Secret"
        echo ""
        corp_id=$(read_input "企业ID (corpId)" "")
        agent_id=$(read_input "AgentId" "")
        secret=$(read_input "Secret" "")
    fi

    # 生成配置
    generate_config "$webhook_path" "$token" "$encoding_aes_key" "$receive_id" "$welcome_text" "$corp_id" "$agent_id" "$secret"
}

# 生成配置文件
generate_config() {
    local webhook_path="$1"
    local token="$2"
    local encoding_aes_key="$3"
    local receive_id="$4"
    local welcome_text="$5"
    local corp_id="$6"
    local agent_id="$7"
    local secret="$8"

    # 确保配置目录存在
    mkdir -p "$(dirname "$CONFIG_FILE")"

    # 检查配置文件是否存在
    if [ -f "$CONFIG_FILE" ]; then
        print_warning "检测到已有配置文件: $CONFIG_FILE"
        local overwrite=$(read_confirm "是否备份并覆盖 wecom 配置？[Y/n]" "Y")
        if [[ "$overwrite" =~ ^[Nn]$ ]]; then
            print_info "跳过配置，请手动编辑配置文件"
            return 0
        fi
        # 备份
        cp "$CONFIG_FILE" "${CONFIG_FILE}.bak.$(date +%Y%m%d%H%M%S)"
        print_success "已备份原配置文件"
    fi

    # 构建 wecom 配置 JSON
    local wecom_config="{"
    wecom_config+="\"enabled\":true,"
    wecom_config+="\"webhookPath\":\"$webhook_path\","
    wecom_config+="\"token\":\"$token\","
    wecom_config+="\"encodingAESKey\":\"$encoding_aes_key\""

    if [ -n "$receive_id" ]; then
        wecom_config+=",\"receiveId\":\"$receive_id\""
    fi

    if [ -n "$welcome_text" ]; then
        wecom_config+=",\"welcomeText\":\"$welcome_text\""
    fi

    if [ -n "$corp_id" ]; then
        wecom_config+=",\"corpId\":\"$corp_id\""
    fi

    if [ -n "$agent_id" ]; then
        wecom_config+=",\"agentId\":$agent_id"
    fi

    if [ -n "$secret" ]; then
        wecom_config+=",\"secret\":\"$secret\""
    fi

    wecom_config+="}"

    # 如果配置文件存在，使用 node 更新；否则创建新文件
    if [ -f "$CONFIG_FILE" ]; then
        # 使用 node 更新配置
        node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
if (!config.channels) config.channels = {};
config.channels.wecom = $wecom_config;
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2));
"
    else
        # 创建新配置文件
        cat > "$CONFIG_FILE" << EOF
{
  "channels": {
    "wecom": $wecom_config
  }
}
EOF
    fi

    print_success "配置已写入: $CONFIG_FILE"
}

# 安装本地命令到 ~/.local/bin
install_local_command() {
    mkdir -p "$BIN_DIR"

    cat > "$BIN_DIR/$BIN_NAME" << 'SCRIPT'
#!/bin/bash
# Clawdbot WeCom 插件管理命令

INSTALL_DIR="${CLAWDBOT_WECOM_DIR:-$HOME/clawdbot-wechat}"
CONFIG_FILE="$HOME/.clawdbot/clawdbot.json"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

case "${1:-help}" in
    update|upgrade)
        echo -e "${BLUE}→ 正在更新 Clawdbot WeCom 插件...${NC}"
        if [ ! -d "$INSTALL_DIR" ]; then
            echo -e "${RED}✗ 插件未安装，请先运行安装脚本${NC}"
            exit 1
        fi
        cd "$INSTALL_DIR"
        git pull
        npm install --silent
        echo -e "${GREEN}✓ 更新完成${NC}"
        if command -v clawdbot &> /dev/null; then
            echo -e "${BLUE}→ 正在重启 gateway...${NC}"
            clawdbot gateway restart 2>/dev/null || echo "请手动重启: clawdbot gateway restart"
        fi
        ;;
    config)
        echo -e "${BLUE}→ 重新运行配置向导...${NC}"
        curl -sSL https://raw.githubusercontent.com/DouDOU-start/clawdbot-wechat/master/install.sh -o /tmp/clawdbot-wecom-install.sh
        bash /tmp/clawdbot-wecom-install.sh --config-only
        rm -f /tmp/clawdbot-wecom-install.sh
        ;;
    status)
        echo "安装目录: $INSTALL_DIR"
        echo "配置文件: $CONFIG_FILE"
        if [ -d "$INSTALL_DIR" ]; then
            echo -e "${GREEN}✓ 插件已安装${NC}"
            cd "$INSTALL_DIR"
            echo "当前版本: $(git log -1 --format='%h %s' 2>/dev/null || echo '未知')"
        else
            echo -e "${RED}✗ 插件未安装${NC}"
        fi
        ;;
    help|--help|-h|*)
        echo "用法: clawdbot-wecom <命令>"
        echo ""
        echo "命令:"
        echo "  update   更新插件到最新版本"
        echo "  config   重新配置企业微信参数"
        echo "  status   查看安装状态"
        echo "  help     显示此帮助信息"
        ;;
esac
SCRIPT

    chmod +x "$BIN_DIR/$BIN_NAME"
    print_success "已安装命令: $BIN_DIR/$BIN_NAME"

    # 检查 PATH
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        print_warning "$BIN_DIR 不在 PATH 中"
        echo ""
        echo "请将以下内容添加到 ~/.bashrc 或 ~/.zshrc："
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
        echo "然后运行: source ~/.bashrc"
    fi
}

# 主安装流程
main() {
    print_banner

    # 检查依赖
    check_command git
    check_command npm
    check_command node

    # 检查是否已安装
    if [ -d "$INSTALL_DIR" ]; then
        print_info "检测到已安装，正在更新..."
        cd "$INSTALL_DIR"
        git pull
        print_success "代码更新完成"
    else
        print_info "正在安装到 $INSTALL_DIR ..."
        git clone "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
        print_success "代码克隆完成"
    fi

    echo ""
    print_info "正在安装依赖..."
    npm install --silent
    print_success "依赖安装完成"

    # 检查 clawdbot 是否存在
    if command -v clawdbot &> /dev/null; then
        echo ""
        print_info "正在注册插件..."
        clawdbot plugins install --link "$INSTALL_DIR" 2>/dev/null || true
        clawdbot plugins enable wecom 2>/dev/null || true
        print_success "插件注册完成"

        # 询问是否进行配置
        echo ""
        local do_config=$(read_confirm "是否进行企业微信配置？[Y/n]" "Y")
        if [[ ! "$do_config" =~ ^[Nn]$ ]]; then
            run_config_wizard
        fi

        echo ""
        print_info "正在重启 gateway..."
        clawdbot gateway restart 2>/dev/null || print_warning "请手动重启 gateway: clawdbot gateway restart"
    else
        print_warning "未检测到 clawdbot，请手动完成以下步骤："
        echo "  1. clawdbot plugins install --link $INSTALL_DIR"
        echo "  2. clawdbot plugins enable wecom"
        echo "  3. 编辑 ~/.clawdbot/clawdbot.json 添加 wecom 配置"
        echo "  4. clawdbot gateway restart"
    fi

    # 安装本地命令
    install_local_command

    echo ""
    echo -e "${GREEN}========================================"
    echo "  安装完成！"
    echo -e "========================================${NC}"
    echo ""
    echo "安装目录: $INSTALL_DIR"
    echo "配置文件: $CONFIG_FILE"
    echo ""
    echo "后续更新只需运行："
    echo "  $BIN_NAME update"
    echo ""
    echo "其他命令："
    echo "  $BIN_NAME config  - 重新配置"
    echo "  $BIN_NAME status  - 查看状态"
    echo ""
}

# 解析参数并运行
if [[ "$1" == "--config-only" ]]; then
    run_config_wizard
    if command -v clawdbot &> /dev/null; then
        print_info "正在重启 gateway..."
        clawdbot gateway restart 2>/dev/null || print_warning "请手动重启 gateway: clawdbot gateway restart"
    fi
else
    main
fi
