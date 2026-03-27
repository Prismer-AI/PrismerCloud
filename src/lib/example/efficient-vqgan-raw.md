# Efficient-VQGAN: Towards High-Resolution Image Generation with Efficient Vision Transformers

**Authors:** Shiyue Cao, Yueqin Yin, Lianghua Huang, Yu Liu, Xin Zhao, Deli Zhao, Kaiqi Huang

**Affiliations:**
- School of Artificial Intelligence, University of Chinese Academy of Sciences
- Institute of Automation, Chinese Academy of Sciences, China
- Machine Intelligence Technology Lab, Alibaba Group, China
- CAS Center for Excellence in Brain Science and Intelligence Technology, China

**Source:** https://arxiv.org/html/2310.05400v1

---

## Abstract

Vector-quantized image modeling has shown great potential in synthesizing high-quality images. However, generating high-resolution images remains a challenging task due to the quadratic computational overhead of the self-attention process. In this study, we seek to explore a more efficient two-stage framework for high-resolution image generation with improvements in the following three aspects. (1) Based on the observation that the first quantization stage has solid local property, we employ a local attention-based quantization model instead of the global attention mechanism used in previous methods, leading to better efficiency and reconstruction quality. (2) We emphasize the importance of multi-grained feature interaction during image generation and introduce an efficient attention mechanism that combines global attention (long-range semantic consistency within the whole image) and local attention (fined-grained details). This approach results in faster generation speed, higher generation fidelity, and improved resolution. (3) We propose a new generation pipeline incorporating autoencoding training and autoregressive generation strategy, demonstrating a better paradigm for image synthesis. Extensive experiments demonstrate the superiority of our approach in high-quality and high-resolution image reconstruction and generation.

---

## 1. Introduction

High-fidelity image synthesis has achieved promising performance thanks to the progress of generative models, such as generative adversarial networks (GANs), diffusion models and autoregressive models. Moreover, high-resolution image generation, a vital generation task with many practical applications, provides better visual effects and user experience in the advertising and design industries.

Some recent studies have attempted to achieve high-resolution image generation. StyleGAN leverages progressive growth to generate high-resolution images. However, GAN-based models often suffer from training stability and poor mode coverage. As diffusion models continue to evolve, recent studies have begun to explore the utilization of cascaded diffusion models for generating high-resolution images. This approach involves training multiple independent and enormous models to collectively accomplish a generation task.

On another note, some researchers leverage a two-stage vector-quantized (VQ) framework for image generation, which first quantizes images into discrete latent codes and then model the data distribution over the discrete space in the second stage. Nonetheless, under the limited computational resources (e.g., memory and training time), the architectures of the existing vector-quantized methods are inferior.

In this paper, to solve the problems of existing models, we would like to explore a more efficient two-stage vector quantized framework for high-resolution image generation and make improvements from the following three aspects:

1. **Local Attention for Quantization:** Prior methods claim the importance of the attention mechanism in the first quantization stage for better image understanding, and they leverage global attention to capture long-range interactions between discrete tokens. However, we find this global attention not necessary for image quantization based on the observation that the alteration of several tokens will only influence their nearby tokens. Hence, local attention can yield satisfactory reconstruction results and circumvent the computationally intensive nature of global attention.

2. **Multi-grained Attention for Generation:** For the second stage of the existing vector-quantized methods, it would be intractable to generate high-resolution images since the quadratic space and time complexity is respected to the discrete sequence length. We utilize multi-grained attention, which implements different granularity of attention operations depending on the distance between tokens.

3. **Autoencoding Training with Autoregressive Generation:** We propose a new generation pipeline incorporating autoencoding training and autoregressive generation strategy, demonstrating a better paradigm for image synthesis.

---

## 2. Related Work

### 2.1 Image Synthesis

High-quality image synthesis has been a fundamental task in computer vision and graphics. Generative adversarial networks (GANs) have been widely adopted for image synthesis due to their ability to generate diverse and visually appealing images. However, GANs often suffer from training instability and mode collapse.

Diffusion models have emerged as a powerful alternative to GANs, demonstrating superior performance in image generation quality. However, diffusion models require multiple denoising steps, resulting in slow generation speed.

Autoregressive models, particularly those based on transformers, have also shown promising results in image synthesis. These models generate images by predicting discrete tokens sequentially.

### 2.2 Vector-Quantized Image Modeling

Vector quantization is a technique that maps continuous representations to a finite set of codebook entries. VQ-VAE introduced the concept of learning discrete representations for images. VQGAN extended this by incorporating adversarial training and perceptual losses, achieving better reconstruction quality.

Recent works like ViT-VQGAN proposed using vision transformers as encoders, showing improved performance in capturing global dependencies. However, the quadratic complexity of self-attention limits the scalability to high-resolution images.

---

## 3. Methodology

### 3.1 Locality of Image Quantization

We observe that changes to individual tokens in the quantized representation primarily affect their local neighborhoods rather than the entire image. This observation motivates our use of local attention mechanisms in the quantization stage.

**Local Attention Mechanism:** Instead of computing attention across all tokens, we restrict attention computation to a local window. This reduces the computational complexity from O(n²) to O(n·k), where k is the local window size.

The local attention operation can be formulated as:
- LocalAttn(Q, K, V) = softmax(QK^T / √d) · V, within local window W

### 3.2 Multi-Grained Attention for Efficient Image Generation

For the generation stage, we propose a multi-grained attention mechanism that combines both global and local attention:

1. **Global Attention (Coarse-grained):** Captures long-range dependencies and ensures semantic consistency across the entire image. We downsample the token sequence before computing global attention to reduce computational cost.

2. **Local Attention (Fine-grained):** Captures detailed local patterns and textures. This operates on the full-resolution token sequence within local windows.

The multi-grained attention output is:
- MultiGrainedAttn(x) = α · GlobalAttn(Downsample(x)) + (1-α) · LocalAttn(x)

where α is a learnable mixing coefficient.

### 3.3 Autoencoding Training and Autoregressive Inference

Our training pipeline consists of two phases:

**Phase 1 - Autoencoding Pretraining:**
- We train the model using masked autoencoding, where random tokens are masked and the model learns to reconstruct them.
- This allows the model to leverage bidirectional context during training.

**Phase 2 - Autoregressive Fine-tuning:**
- We fine-tune the model using autoregressive generation, predicting tokens left-to-right.
- This bridges the gap between training and inference.

---

## 4. Experiments

### 4.1 Image Quantization

**Dataset:** We evaluate on ImageNet at various resolutions (256×256, 512×512, 1024×1024).

**Metrics:** 
- Reconstruction FID (rFID)
- Peak Signal-to-Noise Ratio (PSNR)
- Structural Similarity Index (SSIM)

**Results:**

| Resolution | Method | rFID ↓ | PSNR ↑ | SSIM ↑ |
|------------|--------|--------|--------|--------|
| 256×256 | VQGAN | 1.49 | 23.8 | 0.72 |
| 256×256 | ViT-VQGAN | 1.28 | 24.5 | 0.75 |
| 256×256 | **Ours** | **0.92** | **25.3** | **0.78** |
| 512×512 | VQGAN | 2.31 | 22.1 | 0.68 |
| 512×512 | ViT-VQGAN | 1.89 | 23.2 | 0.71 |
| 512×512 | **Ours** | **1.45** | **24.1** | **0.74** |

Our local attention-based quantization model achieves better reconstruction quality while being more computationally efficient.

### 4.2 Image Synthesis

**Unconditional Generation on ImageNet 256×256:**

| Method | FID ↓ | IS ↑ | Time (s) ↓ |
|--------|-------|------|------------|
| BigGAN | 6.9 | 198.2 | 0.05 |
| StyleGAN-XL | 2.30 | 265.1 | 0.08 |
| VQGAN + Transformer | 15.78 | 78.3 | 2.4 |
| ViT-VQGAN | 4.17 | 175.1 | 1.8 |
| **Ours** | **3.21** | **201.4** | **0.9** |

**Class-Conditional Generation on ImageNet 256×256:**

| Method | FID ↓ | IS ↑ |
|--------|-------|------|
| ADM | 10.94 | 100.98 |
| LDM | 3.60 | 247.67 |
| VQGAN + Transformer | 15.78 | 78.3 |
| ViT-VQGAN | 3.04 | 227.4 |
| **Ours** | **2.67** | **245.2** |

### 4.3 Image Editing Applications

Our method supports various image editing tasks:

1. **Image Inpainting:** The model can fill in masked regions while maintaining consistency with surrounding context.

2. **Image Outpainting:** Extending images beyond their original boundaries with coherent content generation.

3. **Class-guided Editing:** Modifying specific object classes while preserving other image content.

### 4.4 Ablation Studies

**Effect of Local vs Global Attention in Quantization:**

| Attention Type | rFID | GPU Memory | Time |
|----------------|------|------------|------|
| Global | 0.98 | 24GB | 1.2x |
| Local (w=8) | 0.92 | 12GB | 0.6x |
| Local (w=16) | 0.94 | 16GB | 0.8x |

**Effect of Multi-grained Attention:**

| Configuration | FID | IS |
|---------------|-----|-----|
| Global Only | 4.82 | 168.3 |
| Local Only | 5.31 | 142.1 |
| Multi-grained | **3.21** | **201.4** |

---

## 5. Conclusion and Discussion

We have presented Efficient-VQGAN, an efficient two-stage framework for high-resolution image generation. Our key contributions include:

1. **Local Attention-based Quantization:** We demonstrate that local attention is sufficient for image quantization, achieving better reconstruction quality with reduced computational cost.

2. **Multi-grained Attention for Generation:** Our proposed multi-grained attention mechanism effectively combines global semantic consistency with local detail capture, enabling efficient high-resolution image synthesis.

3. **Hybrid Training Strategy:** The combination of autoencoding pretraining and autoregressive fine-tuning provides a robust training paradigm that bridges the gap between bidirectional context learning and sequential generation.

**Limitations:**
- The method still requires significant computational resources for very high resolutions (>1024×1024).
- The discrete tokenization may lose fine-grained details in some cases.

**Future Work:**
- Exploring adaptive attention mechanisms that dynamically adjust granularity.
- Integration with diffusion models for further quality improvements.
- Extension to video generation and 3D content synthesis.

---

## References

1. Esser, P., Rombach, R., & Ommer, B. (2021). Taming Transformers for High-Resolution Image Synthesis. CVPR.
2. Yu, J., et al. (2022). Vector-quantized Image Modeling with Improved VQGAN. ICLR.
3. Karras, T., et al. (2020). Analyzing and Improving the Image Quality of StyleGAN. CVPR.
4. Ho, J., Jain, A., & Abbeel, P. (2020). Denoising Diffusion Probabilistic Models. NeurIPS.
5. Dhariwal, P., & Nichol, A. (2021). Diffusion Models Beat GANs on Image Synthesis. NeurIPS.
6. Liu, Z., et al. (2021). Swin Transformer: Hierarchical Vision Transformer using Shifted Windows. CVPR.
7. Razavi, A., Van den Oord, A., & Vinyals, O. (2019). Generating Diverse High-Fidelity Images with VQ-VAE-2. NeurIPS.
8. Ramesh, A., et al. (2022). Hierarchical Text-Conditional Image Generation with CLIP Latents. arXiv.









