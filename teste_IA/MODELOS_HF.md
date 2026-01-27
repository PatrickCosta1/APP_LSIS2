# Extração de Dados de Faturas com Hugging Face

## Modelos Analisados

### 1. **LayoutLMv3** (Recomendado - Implementado)
- **Tipo**: Document Understanding + OCR integrado
- **Vantagens**:
  - Excelente para documentos estruturados
  - Document Question Answering (DQA) - responde perguntas sobre o documento
  - OCR integrado (não precisa Tesseract)
  - Suporta múltiplos idiomas incluindo português
  - Rápido e preciso
- **Desvantagens**: Requer GPU para performance ótima
- **Modelo**: `microsoft/layoutlmv3-base`

### 2. DONUT (Document Understanding Transformer)
- **Tipo**: End-to-end document understanding
- **Vantagens**:
  - Muito bom para compreensão de layouts
  - Pode fazer OCR + extração estruturada
  - Excelente para documentos específicos (faturas, recibos)
- **Desvantagens**: Mais lento, maior consumo de memória
- **Modelo**: `naver-clova-ix/donut-base-finetuned-rvlcdip`

### 3. DocTr (Document Text Recognition)
- **Tipo**: OCR + Detector de layout
- **Vantagens**:
  - OCR muito preciso
  - Detecta blocos de texto e suas posições
  - Lightweight
- **Desvantagens**: Precisa de processamento adicional para extração
- **Modelo**: `mindee/doctr-pretrained`

### 4. MarianMT + BERT (NER)
- **Tipo**: Named Entity Recognition especializado
- **Vantagens**: Bom para campos específicos em português
- **Desvantagens**: Menos contextual

## Instalação

```bash
# Instalar dependências
pip install -r requirements_hf.txt

# Nota: Pode ser necessário instalar poppler para Windows:
# Download: https://github.com/oschwartz10612/poppler-windows/releases/
# Ou via chocolatey: choco install poppler
```

## Uso

```bash
# Extrair dados de um PDF
python extract_invoice_hf.py ./fatura.pdf

# Extrair dados de uma imagem
python extract_invoice_hf.py ./fatura.jpg
```

## Saída Esperada

```json
{
  "file": "./fatura.pdf",
  "fields": {
    "valorPagar": "125.50€",
    "potenciaContratada": "6.9 kVA",
    "termoEnergia": "45.30€",
    "termoPotencia": "12.50€"
  },
  "page_count": 1,
  "status": "sucesso"
}
```

## Comparação de Performance

| Modelo | Precisão | Velocidade | Memória | Melhor Para |
|--------|----------|-----------|---------|------------|
| LayoutLMv3 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ~4GB | Faturas estruturadas (recomendado) |
| DONUT | ⭐⭐⭐⭐ | ⭐⭐⭐ | ~6GB | Documentos complexos |
| DocTr | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ~2GB | OCR puro |
| BERT NER | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ~1GB | Campos simples |

## Próximos Passos

1. Testar com faturas reais
2. Fine-tune do modelo se necessário (se os campos não forem extraídos corretamente)
3. Integração com backend/API
4. Cache de modelos para performance

## Alternativas Futuras

Se LayoutLMv3 não tiver performance suficiente:
- Fine-tune com dataset de faturas portuguesas
- Usar DONUT com especificação de template
- Combinar LayoutLMv3 + regex para validação
