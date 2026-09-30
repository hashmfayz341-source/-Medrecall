"""Held-out lecture 2 (a two-column study handout, reportlab): python3 make_heldout2.py"""
import os
import images
from reportlab.lib.pagesizes import A4
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle, Image, FrameBreak, NextPageTemplate, PageBreak, ListFlowable, ListItem
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import cm
HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "img")
os.makedirs(IMG, exist_ok=True)
images.histology("adenoma.jpg", 301, base=(235, 190, 215), nuclei=(80, 40, 140), density=250)
images.histology("adenocarcinoma.jpg", 302, base=(220, 150, 190), nuclei=(40, 10, 90), density=900, big=True)
images.histology("leiomyoma.jpg", 303, base=(240, 170, 190), nuclei=(110, 60, 150), density=200)
images.histology("leiomyosarcoma.jpg", 304, base=(210, 120, 160), nuclei=(30, 10, 70), density=1000, big=True)
st = getSampleStyleSheet()
body = ParagraphStyle("b", parent=st["BodyText"], fontName="Helvetica", fontSize=10.5, leading=14, spaceAfter=6)
h1 = ParagraphStyle("h1", parent=st["Heading1"], fontName="Helvetica-Bold", fontSize=18)
h2 = ParagraphStyle("h2", parent=st["Heading2"], fontName="Helvetica-Bold", fontSize=13)
cap = ParagraphStyle("c", parent=body, fontSize=9, textColor=colors.HexColor("#333333"))
W, H = A4
doc = BaseDocTemplate(os.path.join(HERE, "..", "heldout2-neoplasia-anticoagulants.pdf"), pagesize=A4, leftMargin=2*cm, rightMargin=2*cm, topMargin=2*cm, bottomMargin=2*cm)
fw = (W - 4*cm - 0.8*cm) / 2
one = Frame(2*cm, 2*cm, W - 4*cm, H - 4*cm, id="one")
left = Frame(2*cm, 2*cm, fw, H - 4*cm, id="l"); right = Frame(2*cm + fw + 0.8*cm, 2*cm, fw, H - 4*cm, id="r")
doc.addPageTemplates([PageTemplate(id="One", frames=[one]), PageTemplate(id="Two", frames=[left, right])])
S = []
S += [Paragraph("Neoplasia and Antithrombotic Drugs", h1), Paragraph("Study handout — Week 6. Department of Pathology and Pharmacology.", body), Spacer(1, 10)]
S += [Paragraph("Nomenclature", h2), Paragraph("A neoplasm is an abnormal mass of tissue whose growth exceeds that of normal tissue and persists after the stimulus ceases. Benign tumors are designated by attaching the suffix -oma to the cell of origin. Malignant tumors arising in mesenchymal tissue are called sarcomas.", body),
      Paragraph("Carcinomas are malignant neoplasms of epithelial cell origin. They are the most common malignant tumors in adults.", body)]
S += [Paragraph("Features of benign and malignant tumors", h2)]
t = Table([["Feature", "Benign", "Malignant"], ["Differentiation", "Well differentiated", "Variable, may be anaplastic"], ["Rate of growth", "Usually slow", "Often rapid"], ["Local invasion", "Absent; usually encapsulated", "Present"], ["Metastasis", "Absent", "Frequently present"]], colWidths=[4*cm, 6*cm, 6*cm])
t.setStyle(TableStyle([("GRID", (0,0), (-1,-1), 0.5, colors.black), ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"), ("FONTSIZE", (0,0), (-1,-1), 10)]))
S += [t, Spacer(1, 10)]
S += [Paragraph("Metastasis is the most reliable feature that distinguishes a malignant from a benign tumor. Carcinomas typically spread through lymphatics, whereas sarcomas typically spread through the blood.", body)]
S += [Paragraph("Epithelial tumors of the colon", h2)]
imgs = Table([[Image(os.path.join(IMG, "adenoma.jpg"), width=7.5*cm, height=5.6*cm), Image(os.path.join(IMG, "adenocarcinoma.jpg"), width=7.5*cm, height=5.6*cm)],
              [Paragraph("Figure 1: Tubular adenoma of the colon", cap), Paragraph("Figure 2: Invasive adenocarcinoma of the colon", cap)]], colWidths=[8*cm, 8*cm])
S += [imgs, Paragraph("A tubular adenoma is a benign neoplasm of the colonic epithelium. Invasive adenocarcinoma of the colon penetrates the muscularis mucosae.", body)]
S += [PageBreak()]
S += [Paragraph("Smooth muscle tumors of the uterus", h2)]
imgs2 = Table([[Image(os.path.join(IMG, "leiomyoma.jpg"), width=7.5*cm, height=5.6*cm), Image(os.path.join(IMG, "leiomyosarcoma.jpg"), width=7.5*cm, height=5.6*cm)],
               [Paragraph("Figure 3: Leiomyoma (left) and leiomyosarcoma (right) of the uterus", cap), ""]], colWidths=[8*cm, 8*cm])
imgs2.setStyle(TableStyle([("SPAN", (0,1), (1,1))]))
S += [imgs2, Paragraph("Leiomyoma is the most common benign tumor in women. Leiomyosarcomas arise de novo rather than from a preexisting leiomyoma.", body)]
S += [Paragraph("Carcinogenesis", h2), Paragraph("Tumor suppressor genes such as TP53 and RB require loss of both alleles before a cell is transformed. Oncogenes such as RAS promote growth when a single allele is mutated.", body),
      Paragraph("Check your understanding: which tumor spreads mainly by lymphatics?", body)]
S += [NextPageTemplate("Two"), PageBreak()]
S += [Paragraph("Anticoagulants", h2), Paragraph("Heparin", ParagraphStyle("h3", parent=body, fontName="Helvetica-Bold")),
      Paragraph("Heparin activates antithrombin, which inactivates thrombin and factor Xa. It is monitored with the activated partial thromboplastin time. Its effect is reversed by protamine sulfate. It can cause heparin-induced thrombocytopenia.", body),
      Paragraph("Low-molecular-weight heparins such as enoxaparin act mainly on factor Xa.", body),
      FrameBreak(),
      Paragraph("Warfarin", ParagraphStyle("h3b", parent=body, fontName="Helvetica-Bold")),
      Paragraph("Warfarin inhibits vitamin K epoxide reductase. It is monitored with the prothrombin time and the international normalized ratio. Its effect is reversed by vitamin K and fresh frozen plasma. It is contraindicated in pregnancy because it is teratogenic.", body),
      Paragraph("Direct oral anticoagulants such as rivaroxaban inhibit factor Xa directly.", body)]
S += [NextPageTemplate("One"), PageBreak()]
S += [Paragraph("Antiplatelet drugs", h2),
      ListFlowable([ListItem(Paragraph("Aspirin irreversibly inhibits cyclooxygenase and reduces thromboxane A2 synthesis.", body)),
                    ListItem(Paragraph("Clopidogrel blocks the P2Y12 ADP receptor on platelets.", body)),
                    ListItem(Paragraph("Abciximab blocks the glycoprotein IIb/IIIa receptor.", body))], bulletType="bullet"),
      Paragraph("Thrombolytics", h2),
      Paragraph("Alteplase converts plasminogen to plasmin. Its major adverse effect is bleeding.", body),
      Paragraph("Drug interactions to remember", h2)]
t2 = Table([["Drug", "Monitoring test", "Antidote"], ["Heparin", "aPTT", "Protamine sulfate"], ["Warfarin", "PT/INR", "Vitamin K"], ["Dabigatran", "None routinely", "Idarucizumab"]], colWidths=[5*cm, 5*cm, 6*cm])
t2.setStyle(TableStyle([("GRID", (0,0), (-1,-1), 0.5, colors.black), ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold")]))
S += [t2, Spacer(1, 12), Paragraph("Further reading: Kumar V et al. Robbins Basic Pathology, 10th edition, chapter 6.", body)]
doc.build(S)
