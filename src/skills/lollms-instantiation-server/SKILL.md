---
name: lollms-instantiation-server
description: >
  No description provided.
author: Lollms User
version: 1.0.0
category: general
created: 2026-04-09
---

# LoLLMs Server Binding

The native LoLLMs server binding connects to a running LoLLMS instance.

```python
lc = LollmsClient(
    llm_binding_name="lollms",
    llm_binding_config={
        # ─── Connection ──────────────────────────────────
        "host_address": "http://localhost:9642",  # 🔴 MANDATORY
                                                  #    - LoLLMs server URL
        
        "model_name": "mistral",                   # 🔴 MANDATORY
                                                  #    - Model identifier configured in server
        
        # ─── Authentication ──────────────────────────────
        "service_key": "lollms_SOMERANDOMSEQUENCE",  # 🟡 CONTEXTUAL
                                                    #    - Required if server auth enabled but the default behavior is to use it
                                                    #    - Default servers: often "lollms" or custom
        
        # ─── Security ────────────────────────────────────
        "verify_ssl_certificate": True,            # 🟢 default: True
                                                   #    - Verify TLS certificates
                                                   
        "certificate_file_name": "path/to/cert.pem"  # 🟢 Optional
                                                    #    - Custom CA for self-signed certs
    }
)
```

---

## Config Parameter Reference

| Parameter | Tier | Default | Description |
|-----------|------|---------|-------------|
| `host_address` | 🔴 **Mandatory** | — | LoLLMs server URL (default port: **9642**) |
| `model_name` | 🔴 **Mandatory** | — | Model name as configured in LoLLMs server |
| `service_key` | 🟡 **Contextual** | — | Authentication key (required if server has `use_service_key: true`) |
| `verify_ssl_certificate` | 🟢 Optional | `True` | TLS certificate verification |
| `certificate_file_name` | 🟢 Optional | — | Path to custom CA certificate file |

## ⚠️ Common Pitfalls

| Issue | Cause | Solution |
|-------|-------|----------|
| `Connection refused` | Server not running | Start `lollms-webui` or `lollms-core` first |
| `Authentication failed` | Wrong/missing `service_key` | Check server's `use_service_key` and key value |
| `Model not found` | Model not installed server-side | Install via LoLLMs UI or server API first |
| SSL errors | Self-signed cert without override | Set `verify_ssl_certificate=False` or provide cert |
| Port confusion | Using 9624 (llama.cpp) vs 9642 (LoLLMs) | Verify server actual port in logs |


It is advised to put the key inside a LOLLMS_KEY environment variable. if possible propose using a .env with dotenv lobrary to load it.
