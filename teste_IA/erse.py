import requests
import pandas as pd
import io
import zipfile

def carregar_base_dados_erse():
    url = "https://simuladorprecos.erse.pt/Admin/csvs/20260127%20154718%20CSV.zip"
    headers = {'User-Agent': 'Mozilla/5.0'}
    try:
        response = requests.get(url, headers=headers)
        with zipfile.ZipFile(io.BytesIO(response.content)) as z:
            with z.open('csv/CondComerciais.csv') as f:
                cond_df = pd.read_csv(f, sep=';', encoding='latin-1')
            with z.open('csv/Precos_ELEGN.csv') as f:
                precos_df = pd.read_csv(f, sep=';', encoding='latin-1')
            
            # Limpeza de colunas (remove o BOM ï»¿ e espaços extras)
            cond_df.columns = [c.replace('ï»¿', '').strip() for c in cond_df.columns]
            precos_df.columns = [c.replace('ï»¿', '').strip() for c in precos_df.columns]
            
            # Garantir nomes para o Merge
            if 'COM' in cond_df.columns and 'Comercializador' not in cond_df.columns:
                cond_df.rename(columns={'COM': 'Comercializador'}, inplace=True)
            
            precos_df.rename(columns={'COD_Prop': 'COD_Proposta'}, inplace=True)
            
            # Colunas necessárias do catálogo
            cols_catalogo = ['COD_Proposta', 'Comercializador', 'NomeProposta']
            if 'TxTModalidade' in cond_df.columns:
                cols_catalogo.append('TxTModalidade')
            
            # Merge único e limpo
            df_final = pd.merge(precos_df, cond_df[cols_catalogo], on='COD_Proposta')
            return df_final
            
    except Exception as e:
        print(f"⚠️ Erro no carregamento: {e}")
        return None

db = carregar_base_dados_erse()

if db is not None:
    # Identificar a coluna do kWh dinamicamente caso o nome varie ligeiramente
    col_kwh = [c for c in db.columns if 'TV|TVFV|T' in c or 'TVV|TVC' in c][0]
    col_pot_preco = 'TF'
    col_pot_valor = 'Pot_Cont'

    # 1. LIMPEZA DE NÚMEROS
    for col in [col_pot_valor, col_pot_preco, col_kwh]:
        db[col] = db[col].astype(str).str.replace(',', '.').astype(float)

    # 2. FILTRAR POR 6.9 kVA E PREÇOS REAIS
# Adicionamos a condição de que o kWh e o Preço Dia têm de ser > 0.01
    df_69 = db[
        (db[col_pot_valor] == 6.9) & 
        (db[col_kwh] > 0.01) & 
        (db[col_pot_preco] > 0.01)
    ].copy()

    # 3. CÁLCULO DE RANKING (IVA 23%)
    IVA = 1.23
    consumo_anual_est = 3500 
    
    # Dados extraídos do teu PDF
    custo_atual_cliente = (consumo_anual_est * 0.1658) + (0.3396 * 365)

    df_69['kWh_cIVA'] = df_69[col_kwh] * IVA
    df_69['Dia_cIVA'] = df_69[col_pot_preco] * IVA
    
    df_69['Custo_Anual_Novo'] = (consumo_anual_est * df_69['kWh_cIVA']) + (df_69['Dia_cIVA'] * 365)
    df_69['Poupanca'] = custo_atual_cliente - df_69['Custo_Anual_Novo']

    # 4. EXIBIR RESULTADOS
    ranking = df_69.sort_values(by='Poupanca', ascending=False)
    top_propostas = ranking.drop_duplicates(subset=['Comercializador', 'NomeProposta']).head(5)

    print(f"\n🚀 KYNEX: Comparação de Mercado (6.9 kVA)")
    print(f"Estado Atual: {round(custo_atual_cliente, 2)}€/ano")
    print("-" * 65)
    
    for i, (idx, row) in enumerate(top_propostas.iterrows(), 1):
        status = "✅ POUPANÇA" if row['Poupanca'] > 0 else "❌ MAIS CARO"
        print(f"{i}º | {row['Comercializador']} - {row['NomeProposta']}")
        print(f"     kWh: {round(row['kWh_cIVA'], 4)}€ | Dia: {round(row['Dia_cIVA'], 4)}€")
        print(f"     {status}: {round(row['Poupanca'], 2)}€/ano")
        print("-" * 65)