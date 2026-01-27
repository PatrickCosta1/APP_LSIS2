import pdfplumber
import re
import os

def extrator_kynex_v11(caminho_pdf):
    dados = {"Valor Total": 0.0, "Potência kVA": 0.0, "Preço kWh": 0.0, "Preço Potência/Dia": 0.0}
    
    with pdfplumber.open(caminho_pdf) as pdf:
        texto_completo = ""
        for page in pdf.pages:
            texto_completo += (page.extract_text() or "") + "\n"

    # 1. TOTAIS E POTÊNCIA (Geralmente estáveis por Regex)
    total_m = re.search(r"(?:Valor a Pagar|Valor da fatura|Total a pagar|Montante).*?([\d,.]+)", texto_completo, re.I)
    if total_m: dados["Valor Total"] = float(total_m.group(1).replace(',', '.'))

    pot_m = re.search(r"([\d,.]+)\s*(?:kVA|KVA)", texto_completo)
    if pot_m: dados["Potência kVA"] = float(pot_m.group(1).replace(',', '.'))

    # 2. CAPTURA DE TODOS OS CANDIDATOS (Números com 4 casas decimais)
    # Filtramos logo o ruído óbvio (CAV 0.06 e IEC 0.001)
    candidatos = re.findall(r"(\d[,\.]\d{4})", texto_completo)
    precos = sorted(list(set([float(p.replace(',', '.')) for p in candidatos])), reverse=True)

    # 3. ATRIBUIÇÃO POR "ZONAS DE CONFIANÇA"
    # Em Portugal, os preços unitários seguem padrões muito rígidos:
    
    for p in precos:
        # Ignorar CAV e valores insignificantes
        if p == 0.06 or p < 0.01: continue
        
        # A) Zona da Potência Total (0.30€ a 0.50€)
        # Se encontrarmos um valor nesta zona, é quase sempre a Potência Diária Total (SU ou Gold)
        if 0.30 <= p <= 0.48 and dados["Preço Potência/Dia"] == 0.0:
            dados["Preço Potência/Dia"] = p
            continue
            
        # B) Zona do kWh (0.12€ a 0.28€)
        # Se o valor estiver aqui, é o preço da energia
        if 0.12 <= p <= 0.26 and dados["Preço kWh"] == 0.0:
            dados["Preço kWh"] = p

    # 4. CASO ESPECIAL: SOMA DA GOLDENERGY
    # Se a potência ainda está em falta ou é o valor de acesso (0.3174), tentamos somar componentes
    if 0.31 <= dados["Preço Potência/Dia"] <= 0.32:
        # Procuramos o termo fixo (geralmente 0.0222) para somar
        termo_fixo = [p for p in precos if 0.02 <= p <= 0.03]
        if termo_fixo:
            dados["Preço Potência/Dia"] = round(dados["Preço Potência/Dia"] + termo_fixo[0], 4)

    return dados

# --- EXECUÇÃO ---
arquivos = ["teste_IA/104000600704_260109_121840.pdf", "teste_IA/DR2407916069F2503975.PDF"]
for arq in arquivos:
    if os.path.exists(arq):
        res = extrator_kynex_v11(arq)
        print(f"\n✅ {os.path.basename(arq)}")
        print(f"   > Total: {res['Valor Total']}€ | Potência: {res['Potência kVA']}kVA")
        print(f"   > kWh: {res['Preço kWh']}€ | Potência/Dia Total: {res['Preço Potência/Dia']}€")