"""Local-only pairing administration; this command never starts the web/controller."""
import argparse
from pathlib import Path

from .auth import PairStore


def main():
    parser = argparse.ArgumentParser(description="本机 AI 配对管理（不连接烘焙机）")
    parser.add_argument("command", choices=["pair-code", "clients", "revoke"])
    parser.add_argument("--data-dir", default=str(Path(__file__).resolve().parents[2] / "data/ai"))
    parser.add_argument("--client-id")
    args = parser.parse_args()
    store = PairStore(args.data_dir)
    if args.command == "pair-code":
        print("AI 配对码（10 分钟内有效，最多尝试 5 次）：" + store.create_code())
    elif args.command == "clients":
        for client in store.clients():
            print(client["id"], client["name"])
    else:
        if not args.client_id:
            parser.error("revoke 需要 --client-id")
        store.revoke(args.client_id)
        print("客户端已撤销")


if __name__ == "__main__":
    main()
