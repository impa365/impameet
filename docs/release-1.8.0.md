## IMPA Meet 1.8.0 — Segurança de papéis

Imagens: `impa365/impameet-{platform,agent,screen}` nas tags `1.8.0` e `latest`.

### Super admin exclusivo
- Tabela `platform_superadmins` separada das permissões da organização.
- O **primeiro cadastro** de uma instalação vazia vira super admin automaticamente.
- **Só um super admin** concede ou revoga outro (UI em Plataforma → Super admins).
- Permissões `platform.*` nunca entram nos papéis da organização.

### Papéis e permissões da organização
- Papéis padrão: Administrador, Gestor, Usuário — com matriz editável.
- É possível **criar novos papéis** e marcar o que cada um pode fazer.
- O painel admin mostra só as abas liberadas pelas permissões do seu papel.

---

## English

### Exclusive platform super admin
- Separate `platform_superadmins` table; first signup on an empty install is bootstrapped.
- Only a super admin can grant/revoke (Platform → Super admins).
- `platform.*` permissions never attach to org roles.

### Org roles and permissions
- Built-in Admin / Manager / Member with an editable matrix; custom roles supported.
- Admin tabs follow the permissions of your role.
