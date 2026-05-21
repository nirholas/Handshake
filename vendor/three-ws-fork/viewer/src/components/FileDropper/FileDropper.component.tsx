import React, { useEffect, FC, useRef, useState, ReactNode, ReactElement, Children, cloneElement } from 'react';
import styles from './FileDropper.module.scss';

interface DropContainerProps {
  children?: ReactNode | ReactNode[];
  placeholder?: string;
}

/**
 * This component is only for using in Storybook for showcasing drag'n'drop functionality.
 */
export const FileDropper: FC<DropContainerProps> = ({
  children,
  placeholder = `Drag n' Drop a .glb model here, then Drop an animation .glb or .fbx`
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [modelSrc, setModelSrc] = useState('');
  const [animationSrc, setAnimationSrc] = useState('');

  const getBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });

  const handleDrag = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragIn = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDragOut = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer?.items[0].kind === 'file') {
      const file = e.dataTransfer.items[0].getAsFile();

      if (!(file!.name?.endsWith('.glb') || file!.name?.endsWith('.fbx'))) {
        return;
      }

      if (modelSrc === '') {
        setModelSrc(await getBase64(file!));
      }

      if (modelSrc !== '') {
        setAnimationSrc(await getBase64(file!));
      }
    }
  };

  useEffect(() => {
    const element = ref.current!;

    element.addEventListener('dragenter', handleDragIn);
    element.addEventListener('dragleave', handleDragOut);
    element.addEventListener('dragover', handleDrag);
    element.addEventListener('drop', handleDrop);

    return () => {
      element.removeEventListener('dragenter', handleDragIn);
      element.removeEventListener('dragleave', handleDragOut);
      element.removeEventListener('dragover', handleDrag);
      element.removeEventListener('drop', handleDrop);
    };
  });

  return (
    <div className={styles.fileDropContainer} ref={ref}>
      {modelSrc.length < 1 ? (
        <div className={styles.placeholder}>{placeholder}</div>
      ) : (
        Children.map(Children.toArray(children), (child) =>
          cloneElement(child as ReactElement, { modelSrc, animationSrc })
        )
      )}
    </div>
  );
};
