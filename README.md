# 🌤️ Meteo Auditor

Aplicação SvelteKit para análise de dados meteorológicos, preparada para deploy no Cloudflare Pages.

## 🚀 Como executar localmente

### Pré-requisitos
- Node.js 18+ 
- npm

### Instalação
```bash
# Instalar dependências
npm install

# Executar em modo desenvolvimento
npm run dev
```

A aplicação estará disponível em `http://localhost:5173`

## 🏗️ Como construir

```bash
# Construir para produção
npm run build

# Pré-visualizar build de produção
npm run preview
```

## 📋 Funcionalidades

- **Formulário de análise**: Interface para inserir coordenadas geográficas, período e resolução
- **Validação de parâmetros**: Verificação de latitude/longitude válidas e datas coerentes
- **API REST**: Endpoint `/api/analisar` que valida e retorna os parâmetros
- **Interface responsiva**: Design moderno e adaptável

### Parâmetros da API

- `lat`: Latitude (entre -90 e 90)
- `lon`: Longitude (entre -180 e 180)  
- `data_inicio`: Data de início (formato YYYY-MM-DD)
- `data_fim`: Data de fim (formato YYYY-MM-DD)
- `resolucao`: Resolução temporal ("hourly" ou "10min")

### Exemplo de uso

```
GET /api/analisar?lat=41.0&lon=-8.63&data_inicio=2025-05-02&data_fim=2025-05-10&resolucao=hourly
```

## 🚀 Deploy

**Nota**: O deploy será configurado no Cloudflare Pages no próximo passo.

A aplicação está configurada com `@sveltejs/adapter-cloudflare` para otimização no ambiente Cloudflare.

## 🛠️ Tecnologias

- **Frontend**: SvelteKit 5
- **Build**: Vite
- **Adapter**: Cloudflare
- **Linguagem**: TypeScript
- **Estilos**: CSS nativo

## 📁 Estrutura do projeto

```
src/
├── routes/
│   ├── +page.svelte          # Página principal com formulário
│   └── api/
│       └── analisar/
│           └── +server.ts    # Endpoint da API
├── app.html                  # Template HTML base
└── app.css                   # Estilos globais
```

## 🔧 Scripts disponíveis

- `npm run dev` - Servidor de desenvolvimento
- `npm run build` - Build para produção
- `npm run preview` - Pré-visualizar build
- `npm run check` - Verificação de tipos TypeScript
